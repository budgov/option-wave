#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <stdexcept>
#include <vector>

namespace ocean_wave {

constexpr double EPSILON = 1e-12;

inline double clamp(double value, double low, double high) {
    return std::max(low, std::min(high, value));
}

inline double weighted_mean(const std::vector<double>& values, const std::vector<double>& weights) {
    if (values.size() != weights.size()) throw std::runtime_error("weighted arrays have incompatible lengths");
    double numerator = 0.0;
    double denominator = 0.0;
    for (std::size_t i = 0; i < values.size(); ++i) {
        const double weight = std::max(weights[i], EPSILON);
        numerator += values[i] * weight;
        denominator += weight;
    }
    return denominator > EPSILON ? numerator / denominator : 0.0;
}

struct SurfaceAggregate {
    std::vector<double> pair_signal;
    double premium_signal = 0.0;
    double mean_pair_confidence = 0.0;
};

inline SurfaceAggregate aggregate_surface(
    const std::vector<double>& effective_score,
    const std::vector<double>& confidence,
    const std::vector<double>& elo_signal,
    const std::vector<double>& pair_weight
) {
    const std::size_t size = effective_score.size();
    if (confidence.size() != size || elo_signal.size() != size || pair_weight.size() != size) {
        throw std::runtime_error("surface arrays have incompatible lengths");
    }
    SurfaceAggregate result;
    result.pair_signal.resize(size);
    for (std::size_t i = 0; i < size; ++i) {
        const double quality = clamp(confidence[i], 0.0, 1.0);
        const double price_signal = 2.0 * effective_score[i] - 1.0;
        result.pair_signal[i] = quality * elo_signal[i] + (1.0 - quality) * price_signal;
    }
    result.premium_signal = weighted_mean(elo_signal, pair_weight);
    result.mean_pair_confidence = weighted_mean(confidence, pair_weight);
    return result;
}

struct StockConfirmation {
    double signal = 0.0;
    double confidence = 0.0;
};

inline StockConfirmation stock_confirmation(
    double spot,
    double previous_close,
    double vwap,
    double return_5m,
    double return_15m,
    double rvol,
    double realized_vol,
    double data_confidence
) {
    double weighted_sum = 0.0;
    double weight_sum = 0.0;
    int present = 0;
    auto add = [&](double value, double weight) {
        if (!std::isfinite(value)) return;
        weighted_sum += value * weight;
        weight_sum += weight;
        ++present;
    };
    if (std::isfinite(previous_close) && previous_close > 0.0 && spot > 0.0) {
        const double clean_realized_vol = std::isfinite(realized_vol) ? realized_vol : 0.0;
        const double daily_scale = std::max(clean_realized_vol / std::sqrt(252.0), 0.005);
        add(std::log(spot / previous_close) / daily_scale, 0.25);
    }
    if (std::isfinite(vwap) && vwap > 0.0) add((spot - vwap) / vwap / 0.003, 0.25);
    if (std::isfinite(return_5m)) add(return_5m / 0.003, 0.25);
    if (std::isfinite(return_15m)) add(return_15m / 0.006, 0.15);
    if (std::isfinite(rvol) && rvol > 0.0) add(std::log(std::max(rvol, EPSILON)), 0.10);
    if (weight_sum <= EPSILON) return {};
    return {
        std::tanh(weighted_sum / weight_sum),
        clamp(static_cast<double>(present) / 5.0 * clamp(data_confidence, 0.0, 1.0), 0.0, 1.0)
    };
}

struct GradientStencil {
    int axis = 0;
    std::vector<double> lower;
    std::vector<double> center;
    std::vector<double> upper;
};

inline GradientStencil make_gradient_stencil(const std::vector<double>& coordinates, int axis) {
    GradientStencil stencil;
    stencil.axis = axis;
    const std::size_t length = coordinates.size();
    stencil.lower.assign(length, 0.0);
    stencil.center.assign(length, 0.0);
    stencil.upper.assign(length, 0.0);
    if (length < 2) return stencil;
    const double first_span = coordinates[1] - coordinates[0];
    if (first_span > EPSILON) {
        stencil.center[0] = -1.0 / first_span;
        stencil.upper[0] = 1.0 / first_span;
    }
    const double last_span = coordinates[length - 1] - coordinates[length - 2];
    if (last_span > EPSILON) {
        stencil.lower[length - 1] = -1.0 / last_span;
        stencil.center[length - 1] = 1.0 / last_span;
    }
    for (std::size_t position = 1; position + 1 < length; ++position) {
        const double left_span = coordinates[position] - coordinates[position - 1];
        const double right_span = coordinates[position + 1] - coordinates[position];
        const double denominator = left_span * right_span * (left_span + right_span);
        if (denominator <= EPSILON) continue;
        stencil.lower[position] = -right_span * right_span / denominator;
        stencil.center[position] = (right_span * right_span - left_span * left_span) / denominator;
        stencil.upper[position] = left_span * left_span / denominator;
    }
    return stencil;
}

inline void apply_gradient(
    const std::vector<double>& field,
    int rows,
    int cols,
    const GradientStencil& stencil,
    std::vector<double>& output
) {
    if (output.size() != field.size()) output.resize(field.size());
    const int length = stencil.axis == 1 ? cols : rows;
    if (length < 2) {
        std::fill(output.begin(), output.end(), 0.0);
        return;
    }
    const int stride = stencil.axis == 1 ? 1 : cols;
    for (int row = 0; row < rows; ++row) {
        for (int col = 0; col < cols; ++col) {
            const int index = row * cols + col;
            const int position = stencil.axis == 1 ? col : row;
            double value = stencil.center[position] * field[index];
            if (position > 0) value += stencil.lower[position] * field[index - stride];
            if (position + 1 < length) value += stencil.upper[position] * field[index + stride];
            output[index] = value;
        }
    }
}

struct Evolution {
    std::vector<double> field;
    std::vector<double> integrals;
    std::vector<double> averages;
};

inline Evolution evolve(
    const std::vector<double>& observed,
    const std::vector<double>& weights,
    const std::vector<double>& distances,
    const std::vector<double>& expiries,
    double distance_diffusion,
    double expiry_diffusion,
    double distance_drift,
    double decay,
    double source_strength,
    double timestep_minutes,
    const std::vector<double>& horizons
) {
    const int rows = static_cast<int>(expiries.size());
    const int cols = static_cast<int>(distances.size());
    const int size = rows * cols;
    if (observed.size() != static_cast<std::size_t>(size) || weights.size() != observed.size() || horizons.empty()) {
        throw std::runtime_error("forecast field arrays or horizons are invalid");
    }
    const double dt = std::max(timestep_minutes, 1e-6);
    const double max_horizon = *std::max_element(horizons.begin(), horizons.end());
    const int steps = static_cast<int>(std::ceil(max_horizon / dt));
    std::vector<double> field = observed;
    std::vector<double> next(size);
    std::vector<double> scores(steps + 1);
    std::vector<double> gradient_scratch(size);
    std::vector<double> gradient_distance(size);
    std::vector<double> lap_distance(size);
    std::vector<double> lap_expiry(size);
    const GradientStencil distance_stencil = make_gradient_stencil(distances, 1);
    const GradientStencil expiry_stencil = make_gradient_stencil(expiries, 0);
    scores[0] = weighted_mean(field, weights);
    for (int step = 1; step <= steps; ++step) {
        apply_gradient(field, rows, cols, distance_stencil, gradient_distance);
        apply_gradient(gradient_distance, rows, cols, distance_stencil, lap_distance);
        apply_gradient(field, rows, cols, expiry_stencil, gradient_scratch);
        apply_gradient(gradient_scratch, rows, cols, expiry_stencil, lap_expiry);
        for (int i = 0; i < size; ++i) {
            const double derivative = -distance_drift * gradient_distance[i]
                + distance_diffusion * lap_distance[i]
                + expiry_diffusion * lap_expiry[i]
                - decay * field[i]
                + source_strength * (observed[i] - field[i]);
            next[i] = clamp(field[i] + dt * derivative, -1.0, 1.0);
        }
        field.swap(next);
        scores[step] = weighted_mean(field, weights);
    }
    Evolution result;
    result.field = std::move(field);
    result.integrals.reserve(horizons.size());
    result.averages.reserve(horizons.size());
    for (const double horizon : horizons) {
        const int index = std::min(steps, static_cast<int>(std::ceil(horizon / dt)));
        double integral = 0.0;
        for (int i = 1; i <= index; ++i) integral += 0.5 * (scores[i] + scores[i - 1]) * dt;
        const double elapsed = std::max(index * dt, EPSILON);
        result.integrals.push_back(integral);
        result.averages.push_back(integral / elapsed);
    }
    return result;
}

struct Forecast {
    std::vector<double> distances;
    std::vector<double> expiries;
    std::vector<double> field;
    std::vector<double> integrals;
    std::vector<double> averages;
    std::vector<double> expected_returns;
    std::vector<double> expected_prices;
    std::vector<double> return_variances;
    std::vector<double> price_variances;
    std::vector<double> probabilities_up;
    double current_field_signal = 0.0;
    double trend_score = 0.0;
    double confidence = 0.0;
    double median_distance = 0.0;
};

inline Forecast forecast_surface(
    const std::vector<double>& row_expiry,
    const std::vector<double>& row_distance,
    const std::vector<double>& row_pair_signal,
    const std::vector<double>& row_pair_weight,
    const std::vector<double>& row_pair_variance,
    double composite_signal,
    double composite_confidence,
    double projected_factor_variance,
    double spot,
    double volatility,
    double liquidity_quality,
    double volatility_risk_premium,
    double vrp_variance_scale,
    double gamma_multiplier,
    double trading_minutes_per_year,
    double distance_diffusion,
    double expiry_diffusion,
    double distance_drift,
    double decay,
    double source_strength,
    double timestep_minutes,
    const std::vector<double>& horizons
) {
    const std::size_t row_count = row_expiry.size();
    if (row_count == 0 || row_distance.size() != row_count || row_pair_signal.size() != row_count
        || row_pair_weight.size() != row_count || row_pair_variance.size() != row_count || horizons.empty()) {
        throw std::runtime_error("forecast surface rows are invalid");
    }
    Forecast result;
    result.distances = row_distance;
    result.expiries = row_expiry;
    std::sort(result.distances.begin(), result.distances.end());
    std::sort(result.expiries.begin(), result.expiries.end());
    result.distances.erase(std::unique(result.distances.begin(), result.distances.end()), result.distances.end());
    result.expiries.erase(std::unique(result.expiries.begin(), result.expiries.end()), result.expiries.end());
    const int cols = static_cast<int>(result.distances.size());
    const int rows = static_cast<int>(result.expiries.size());
    const int size = rows * cols;
    std::vector<double> observed(size, 0.0);
    std::vector<double> weights(size, 0.0);
    for (std::size_t i = 0; i < row_count; ++i) {
        const int col = static_cast<int>(std::lower_bound(result.distances.begin(), result.distances.end(), row_distance[i]) - result.distances.begin());
        const int row = static_cast<int>(std::lower_bound(result.expiries.begin(), result.expiries.end(), row_expiry[i]) - result.expiries.begin());
        observed[row * cols + col] = row_pair_signal[i];
        weights[row * cols + col] = row_pair_weight[i];
    }
    result.current_field_signal = weighted_mean(observed, weights);
    std::vector<double> source_basis(size);
    std::vector<double> distance_basis(cols);
    std::vector<double> expiry_basis(rows);
    for (int col = 0; col < cols; ++col) {
        distance_basis[col] = std::exp(-std::abs(result.distances[col]) / 0.08);
    }
    for (int row = 0; row < rows; ++row) {
        expiry_basis[row] = std::exp(-result.expiries[row] / 45.0);
    }
    for (int row = 0; row < rows; ++row) {
        for (int col = 0; col < cols; ++col) {
            source_basis[row * cols + col] = distance_basis[col] * expiry_basis[row];
        }
    }
    const double basis_mean = std::max(weighted_mean(source_basis, weights), EPSILON);
    for (int i = 0; i < size; ++i) {
        observed[i] = clamp(
            observed[i] + (composite_signal - result.current_field_signal) * source_basis[i] / basis_mean,
            -1.0,
            1.0
        );
    }
    const Evolution evolution = evolve(
        observed, weights, result.distances, result.expiries,
        distance_diffusion, expiry_diffusion, distance_drift, decay, source_strength,
        timestep_minutes, horizons
    );
    result.field = evolution.field;
    result.integrals = evolution.integrals;
    result.averages = evolution.averages;
    result.expected_returns.reserve(horizons.size());
    result.expected_prices.reserve(horizons.size());
    result.return_variances.reserve(horizons.size());
    result.price_variances.reserve(horizons.size());
    result.probabilities_up.reserve(horizons.size());
    const double mean_pair_variance = weighted_mean(row_pair_variance, row_pair_weight);
    const double risk_multiplier = 1.0 + mean_pair_variance + projected_factor_variance
        + (1.0 - clamp(liquidity_quality, 0.0, 1.0))
        + vrp_variance_scale * std::abs(volatility_risk_premium);
    for (std::size_t i = 0; i < horizons.size(); ++i) {
        const double year_fraction = horizons[i] / std::max(trading_minutes_per_year, EPSILON);
        const double expected_log_return = result.averages[i] * volatility
            * std::sqrt(std::max(year_fraction, 0.0)) * gamma_multiplier;
        const double return_variance = volatility * volatility * std::max(year_fraction, 0.0) * risk_multiplier;
        const double expected_price = spot * std::exp(expected_log_return + 0.5 * return_variance);
        const double expected_return = std::expm1(expected_log_return + 0.5 * return_variance);
        const double price_variance = expected_price * expected_price * std::expm1(return_variance);
        const double z_score = expected_log_return / std::max(std::sqrt(return_variance), EPSILON);
        result.expected_returns.push_back(expected_return);
        result.expected_prices.push_back(expected_price);
        result.return_variances.push_back(return_variance);
        result.price_variances.push_back(std::max(price_variance, 0.0));
        result.probabilities_up.push_back(0.5 * (1.0 + std::erf(z_score / std::sqrt(2.0))));
    }
    result.trend_score = std::tanh(result.averages.back());
    result.confidence = clamp(
        composite_confidence * (0.35 + 0.65 * liquidity_quality) * std::exp(-projected_factor_variance),
        0.0,
        1.0
    );
    const std::size_t mid = result.distances.size() / 2;
    result.median_distance = result.distances.size() % 2 == 0
        ? 0.5 * (result.distances[mid - 1] + result.distances[mid])
        : result.distances[mid];
    return result;
}

}  // namespace ocean_wave
