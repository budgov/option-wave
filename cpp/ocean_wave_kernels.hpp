#pragma once

#include <algorithm>
#include <array>
#include <climits>
#include <cmath>
#include <cstddef>
#include <limits>
#include <stdexcept>
#include <utility>
#include <vector>

namespace ocean_wave {

constexpr double EPSILON = 1e-12;
constexpr std::size_t FOURIER_MIN_SAMPLES = 8;
constexpr std::size_t FOURIER_MAX_SAMPLES = 4096;
constexpr std::size_t FOURIER_MAX_HARMONICS = 256;
constexpr std::size_t FOURIER_BAND_COUNT = 4;
constexpr double FOURIER_MAX_ABS_RETURN = 10.0;
constexpr double FOURIER_MIN_SAMPLE_INTERVAL = 1e-9;
constexpr double FOURIER_MAX_SAMPLE_INTERVAL = 1e9;
constexpr double TWO_PI = 6.283185307179586476925286766559;

inline double clamp(double value, double low, double high) {
    return std::max(low, std::min(high, value));
}

inline bool all_finite(const std::vector<double>& values) {
    return std::all_of(values.begin(), values.end(), [](double value) { return std::isfinite(value); });
}

struct FactorBudgetBlend {
    std::vector<double> mean;
    std::vector<double> covariance;
    std::vector<double> weights;
    double signal = 0.0;
    double confidence = 0.0;
    double projected_variance = 0.0;
    double count = 0.0;
    double kkt_residual = 0.0;
};

// Box-constrained, strictly convex QP. Missing budgets remain neutral; the
// solver never renormalizes surviving factors. Squared correlations are PSD
// by the Schur product theorem and penalize redundant evidence of either sign.
inline FactorBudgetBlend blend_factor_budgets(
    const std::vector<double>& factors,
    const std::vector<double>& confidences,
    const std::vector<double>& budgets,
    const std::vector<double>& previous_mean,
    const std::vector<double>& previous_covariance,
    double observation_count,
    double alpha,
    double penalty,
    double shrinkage
) {
    const std::size_t n = factors.size();
    if (n == 0 || n > 32 || confidences.size() != n || budgets.size() != n
        || previous_mean.size() != n || previous_covariance.size() != n * n
        || !all_finite(previous_mean) || !all_finite(previous_covariance)
        || !all_finite(budgets) || !std::isfinite(observation_count) || observation_count < 0.0
        || !std::isfinite(alpha) || alpha <= 0.0 || alpha > 1.0
        || !std::isfinite(penalty) || penalty < 0.0 || penalty >= 1.0
        || !std::isfinite(shrinkage) || shrinkage < 0.0 || shrinkage > 1.0) {
        throw std::invalid_argument("invalid factor budget inputs");
    }
    double total_budget = 0.0;
    for (double value : budgets) {
        if (value < 0.0) throw std::invalid_argument("negative factor budget");
        total_budget += value;
    }
    if (total_budget <= 0.0 || total_budget > 1.0 + EPSILON) {
        throw std::invalid_argument("factor budgets must sum to at most one");
    }
    FactorBudgetBlend out;
    out.mean = previous_mean;
    out.covariance = previous_covariance;
    out.count = observation_count;
    std::vector<double> clean(n), quality(n), upper(n), innovation(n), decay(n, 1.0);
    bool observed = false;
    for (std::size_t i = 0; i < n; ++i) {
        const bool valid = std::isfinite(factors[i]) && std::isfinite(confidences[i]);
        clean[i] = valid ? clamp(factors[i], -1.0, 1.0) : 0.0;
        quality[i] = valid ? clamp(confidences[i], 0.0, 1.0) : 0.0;
        upper[i] = budgets[i] * quality[i];
        if (quality[i] <= 0.0) continue;
        observed = true;
        innovation[i] = clean[i] - previous_mean[i];
        decay[i] = std::sqrt(1.0 - alpha);
        out.mean[i] = observation_count <= 0.0 ? clean[i] : previous_mean[i] + alpha * innovation[i];
    }
    if (observed && observation_count > 0.0) {
        // This PSD-preserving masked EWMA retains uncertainty for absent data.
        for (std::size_t i = 0; i < n; ++i) {
            for (std::size_t j = 0; j < n; ++j) {
                out.covariance[i * n + j] = previous_covariance[i * n + j] * decay[i] * decay[j]
                    + alpha * (1.0 - alpha) * innovation[i] * innovation[j];
            }
        }
    }
    if (observed) out.count += 1.0;
    std::vector<double> hessian(n * n, 0.0);
    for (std::size_t i = 0; i < n; ++i) {
        for (std::size_t j = 0; j < n; ++j) {
            const double denominator = std::sqrt(std::max(out.covariance[i * n + i], EPSILON)
                * std::max(out.covariance[j * n + j], EPSILON));
            const double correlation = i == j ? 1.0 : clamp(out.covariance[i * n + j] / denominator, -1.0, 1.0);
            const double redundancy = (1.0 - shrinkage) * correlation * correlation + (i == j ? shrinkage : 0.0);
            // Remove self-correlation shrinkage, retaining positive definiteness
            // through H=(1-lambda)I+lambda*R, 0<=lambda<1.
            hessian[i * n + j] = (i == j ? 1.0 - penalty : 0.0) + penalty * redundancy;
        }
    }
    out.weights = upper;
    for (std::size_t iteration = 0; iteration < 512; ++iteration) {
        double largest_change = 0.0;
        for (std::size_t i = 0; i < n; ++i) {
            double off_diagonal = 0.0;
            for (std::size_t j = 0; j < n; ++j) {
                if (i != j) off_diagonal += hessian[i * n + j] * out.weights[j];
            }
            const double updated = clamp((upper[i] - off_diagonal) / hessian[i * n + i], 0.0, upper[i]);
            largest_change = std::max(largest_change, std::abs(updated - out.weights[i]));
            out.weights[i] = updated;
        }
        if (largest_change < 1e-13) break;
    }
    for (std::size_t i = 0; i < n; ++i) {
        double gradient = -upper[i];
        out.signal += out.weights[i] * clean[i];
        // Observation quality already limits each weight's eligible budget.
        // Multiplying it again would count the same missingness twice.
        out.confidence += out.weights[i];
        for (std::size_t j = 0; j < n; ++j) {
            gradient += hessian[i * n + j] * out.weights[j];
            out.projected_variance += out.weights[i] * out.covariance[i * n + j] * out.weights[j];
        }
        out.kkt_residual = std::max(out.kkt_residual,
            std::abs(out.weights[i] - clamp(out.weights[i] - gradient, 0.0, upper[i])));
    }
    if (out.kkt_residual > 1e-9) throw std::runtime_error("factor budget QP did not converge");
    out.signal = clamp(out.signal, -1.0, 1.0);
    out.confidence = clamp(out.confidence, 0.0, 1.0);
    out.projected_variance = std::max(out.projected_variance, 0.0);
    return out;
}

struct IntradayFourierFeatures {
    std::size_t sample_count = 0;
    std::size_t harmonic_count = 0;
    double sample_interval = 0.0;
    double mean = 0.0;
    double input_variance = 0.0;
    double variance = 0.0;
    bool linear_detrend = true;
    bool hann_taper = true;
    double linear_trend_intercept = 0.0;
    double linear_trend_slope_per_sample = 0.0;
    double taper_coherent_gain = 1.0;
    double taper_power_gain = 1.0;
    std::vector<std::size_t> harmonics;
    std::vector<double> frequencies;
    std::vector<double> periods;
    std::vector<double> cosine_coefficients;
    std::vector<double> sine_coefficients;
    std::vector<double> amplitudes;
    std::vector<double> phases;
    std::vector<double> power;
    double retained_energy = 0.0;
    double explained_energy_fraction = 0.0;
    double spectral_entropy = 0.0;
    std::size_t dominant_harmonic = 0;
    double dominant_period = 0.0;
    double dominant_phase = 0.0;
    double dominant_phase_sine = 0.0;
    double dominant_phase_cosine = 0.0;
    std::array<double, FOURIER_BAND_COUNT> band_energy{};
    std::array<double, FOURIER_BAND_COUNT> band_energy_fraction{};
    double out_of_band_energy = 0.0;
    double out_of_band_energy_fraction = 0.0;
    double band_covered_energy_fraction = 0.0;
};

// Extract a bounded low-frequency DFT from a causal prefix of equally spaced
// returns. valid_length is explicit so callers may reuse a fixed input buffer
// without exposing observations after the forecast cut-off. The kernel neither
// pads nor centres the series around a future point.
inline IntradayFourierFeatures extract_intraday_fourier(
    const std::vector<double>& returns,
    std::size_t valid_length,
    std::size_t max_harmonics,
    double sample_interval,
    bool linear_detrend = true,
    bool hann_taper = true
) {
    if (returns.size() > FOURIER_MAX_SAMPLES || valid_length < FOURIER_MIN_SAMPLES
        || valid_length > returns.size() || max_harmonics == 0
        || max_harmonics > FOURIER_MAX_HARMONICS || !std::isfinite(sample_interval)
        || sample_interval < FOURIER_MIN_SAMPLE_INTERVAL
        || sample_interval > FOURIER_MAX_SAMPLE_INTERVAL) {
        throw std::runtime_error("intraday Fourier dimensions or sample interval are invalid");
    }
    for (std::size_t index = 0; index < valid_length; ++index) {
        if (!std::isfinite(returns[index]) || std::abs(returns[index]) > FOURIER_MAX_ABS_RETURN) {
            throw std::runtime_error("intraday Fourier returns exceed the finite causal safety range");
        }
    }

    IntradayFourierFeatures result;
    result.sample_count = valid_length;
    result.sample_interval = sample_interval;
    result.harmonic_count = std::min(max_harmonics, valid_length / 2);
    result.linear_detrend = linear_detrend;
    result.hann_taper = hann_taper;

    // Compensated accumulation keeps demeaning stable for small intraday
    // returns sitting on a non-zero baseline.
    double sum = 0.0;
    double correction = 0.0;
    for (std::size_t index = 0; index < valid_length; ++index) {
        const double adjusted = returns[index] - correction;
        const double next = sum + adjusted;
        correction = (next - sum) - adjusted;
        sum = next;
    }
    result.mean = sum / static_cast<double>(valid_length);

    const double centre = 0.5 * static_cast<double>(valid_length - 1);
    double trend_numerator = 0.0;
    double trend_denominator = 0.0;
    double input_square_sum = 0.0;
    for (std::size_t index = 0; index < valid_length; ++index) {
        const double demeaned = returns[index] - result.mean;
        const double centred_index = static_cast<double>(index) - centre;
        trend_numerator += centred_index * demeaned;
        trend_denominator += centred_index * centred_index;
        input_square_sum += demeaned * demeaned;
    }
    result.input_variance = std::max(input_square_sum / static_cast<double>(valid_length), 0.0);
    result.linear_trend_slope_per_sample = linear_detrend && trend_denominator > 0.0
        ? trend_numerator / trend_denominator
        : 0.0;
    result.linear_trend_intercept = result.mean - result.linear_trend_slope_per_sample * centre;

    std::vector<double> analysis_values(valid_length);
    double residual_square_sum = 0.0;
    double window_sum = 0.0;
    double window_square_sum = 0.0;
    for (std::size_t index = 0; index < valid_length; ++index) {
        const double fitted = result.linear_trend_intercept
            + result.linear_trend_slope_per_sample * static_cast<double>(index);
        const double residual = returns[index] - fitted;
        const double window = hann_taper
            ? 0.5 * (1.0 - std::cos(TWO_PI * static_cast<double>(index)
                / static_cast<double>(valid_length - 1)))
            : 1.0;
        analysis_values[index] = residual * window;
        residual_square_sum += residual * residual;
        window_sum += window;
        window_square_sum += window * window;
    }
    result.variance = std::max(residual_square_sum / static_cast<double>(valid_length), 0.0);
    result.taper_coherent_gain = window_sum / static_cast<double>(valid_length);
    result.taper_power_gain = window_square_sum / static_cast<double>(valid_length);

    const std::size_t harmonic_count = result.harmonic_count;
    result.harmonics.reserve(harmonic_count);
    result.frequencies.reserve(harmonic_count);
    result.periods.reserve(harmonic_count);
    result.cosine_coefficients.reserve(harmonic_count);
    result.sine_coefficients.reserve(harmonic_count);
    result.amplitudes.reserve(harmonic_count);
    result.phases.reserve(harmonic_count);
    result.power.reserve(harmonic_count);

    double dominant_power = 0.0;
    for (std::size_t harmonic = 1; harmonic <= harmonic_count; ++harmonic) {
        const double angle_step = TWO_PI * static_cast<double>(harmonic)
            / static_cast<double>(valid_length);
        const double step_cosine = std::cos(angle_step);
        const double step_sine = std::sin(angle_step);
        double current_cosine = 1.0;
        double current_sine = 0.0;
        double cosine_sum = 0.0;
        double sine_sum = 0.0;
        for (std::size_t index = 0; index < valid_length; ++index) {
            cosine_sum += analysis_values[index] * current_cosine;
            sine_sum += analysis_values[index] * current_sine;
            const double next_cosine = current_cosine * step_cosine - current_sine * step_sine;
            const double next_sine = current_sine * step_cosine + current_cosine * step_sine;
            current_cosine = next_cosine;
            current_sine = next_sine;
            if ((index & 255U) == 255U) {
                const double norm = std::hypot(current_cosine, current_sine);
                if (norm > 0.0) {
                    current_cosine /= norm;
                    current_sine /= norm;
                }
            }
        }

        const bool is_nyquist = valid_length % 2 == 0 && harmonic == valid_length / 2;
        const double coefficient_scale = (is_nyquist ? 1.0 : 2.0)
            / static_cast<double>(valid_length);
        const double raw_cosine_coefficient = coefficient_scale * cosine_sum;
        const double raw_sine_coefficient = is_nyquist ? 0.0 : coefficient_scale * sine_sum;
        const double cosine_coefficient = raw_cosine_coefficient / result.taper_coherent_gain;
        const double sine_coefficient = raw_sine_coefficient / result.taper_coherent_gain;
        const double amplitude = std::hypot(cosine_coefficient, sine_coefficient);
        const double raw_component_power = is_nyquist
            ? raw_cosine_coefficient * raw_cosine_coefficient
            : 0.5 * (raw_cosine_coefficient * raw_cosine_coefficient
                + raw_sine_coefficient * raw_sine_coefficient);
        const double component_power = raw_component_power / result.taper_power_gain;
        const double frequency = static_cast<double>(harmonic)
            / (static_cast<double>(valid_length) * sample_interval);
        const double period = frequency > 0.0 ? 1.0 / frequency : 0.0;

        result.harmonics.push_back(harmonic);
        result.frequencies.push_back(frequency);
        result.periods.push_back(period);
        result.cosine_coefficients.push_back(cosine_coefficient);
        result.sine_coefficients.push_back(sine_coefficient);
        result.amplitudes.push_back(amplitude);
        // Standard DFT phase: x[n] = amplitude * cos(angle + phase).
        result.phases.push_back(std::atan2(-sine_coefficient, cosine_coefficient));
        result.power.push_back(component_power);
        result.retained_energy += component_power;

        std::size_t band = FOURIER_BAND_COUNT;
        if (period >= 2.0 && period < 5.0) band = 0;
        else if (period >= 5.0 && period < 15.0) band = 1;
        else if (period >= 15.0 && period < 60.0) band = 2;
        else if (period >= 60.0 && period <= 120.0) band = 3;
        if (band < FOURIER_BAND_COUNT) result.band_energy[band] += component_power;
        else result.out_of_band_energy += component_power;
        if (component_power > dominant_power) {
            dominant_power = component_power;
            result.dominant_harmonic = harmonic;
            result.dominant_period = period;
            result.dominant_phase = result.phases.back();
        }
    }

    double covered_energy = 0.0;
    for (std::size_t band = 0; band < FOURIER_BAND_COUNT; ++band) {
        covered_energy += result.band_energy[band];
        result.band_energy_fraction[band] = result.retained_energy > 0.0
            ? result.band_energy[band] / result.retained_energy
            : 0.0;
    }
    result.out_of_band_energy_fraction = result.retained_energy > 0.0
        ? result.out_of_band_energy / result.retained_energy
        : 0.0;
    result.band_covered_energy_fraction = result.retained_energy > 0.0
        ? covered_energy / result.retained_energy
        : 0.0;
    result.explained_energy_fraction = result.variance > 0.0
        ? clamp(result.retained_energy / result.variance, 0.0, 1.0)
        : 0.0;
    if (result.retained_energy > 0.0 && harmonic_count > 1) {
        double entropy = 0.0;
        for (const double component_power : result.power) {
            if (component_power <= 0.0) continue;
            const double probability = component_power / result.retained_energy;
            entropy -= probability * std::log(probability);
        }
        result.spectral_entropy = clamp(entropy / std::log(static_cast<double>(harmonic_count)), 0.0, 1.0);
    }
    if (result.variance == 0.0 || result.retained_energy == 0.0) {
        result.dominant_harmonic = 0;
        result.dominant_period = 0.0;
        result.dominant_phase = 0.0;
        result.dominant_phase_sine = 0.0;
        result.dominant_phase_cosine = 0.0;
    } else {
        result.dominant_phase_sine = std::sin(result.dominant_phase);
        result.dominant_phase_cosine = std::cos(result.dominant_phase);
    }
    return result;
}

inline int checked_grid_size(std::size_t rows, std::size_t cols) {
    constexpr std::size_t max_grid_elements = 1'000'000;
    if (rows == 0 || cols == 0 || rows > static_cast<std::size_t>(INT_MAX)
        || cols > static_cast<std::size_t>(INT_MAX)
        || rows > static_cast<std::size_t>(INT_MAX) / cols
        || rows > max_grid_elements / cols) {
        throw std::runtime_error("forecast grid dimensions are invalid or too large");
    }
    return static_cast<int>(rows * cols);
}

inline int checked_step_count(const std::vector<double>& horizons, double timestep) {
    if (horizons.empty() || horizons.size() > 10'000 || !std::isfinite(timestep) || timestep <= 0.0 || !all_finite(horizons)
        || std::any_of(horizons.begin(), horizons.end(), [](double value) { return value <= 0.0; })) {
        throw std::runtime_error("forecast horizons or timestep are invalid");
    }
    const double raw_steps = std::ceil(*std::max_element(horizons.begin(), horizons.end()) / timestep);
    constexpr double max_steps = 1'000'000.0;
    if (!std::isfinite(raw_steps) || raw_steps < 1.0 || raw_steps > max_steps) {
        throw std::runtime_error("forecast step count exceeds the safety limit");
    }
    return static_cast<int>(raw_steps);
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
    if (std::isfinite(previous_close) && previous_close > 0.0 && std::isfinite(spot) && spot > 0.0) {
        const double clean_realized_vol = std::isfinite(realized_vol) ? realized_vol : 0.0;
        const double daily_scale = std::max(clean_realized_vol / std::sqrt(252.0), 0.005);
        add(std::log(spot / previous_close) / daily_scale, 0.25);
    }
    if (std::isfinite(vwap) && vwap > 0.0 && std::isfinite(spot) && spot > 0.0) add((spot - vwap) / vwap / 0.003, 0.25);
    if (std::isfinite(return_5m)) add(return_5m / 0.003, 0.25);
    if (std::isfinite(return_15m)) add(return_15m / 0.006, 0.15);
    if (weight_sum <= EPSILON) return {};
    // RVOL is unsigned activity: affect confidence, never independent direction.
    const double volume_quality = std::isfinite(rvol) && rvol > 0.0
        ? 0.75 + 0.25 * std::tanh(std::log(std::max(rvol, EPSILON))) : 0.75;
    const double clean_confidence = std::isfinite(data_confidence) ? clamp(data_confidence, 0.0, 1.0) : 0.0;
    return {
        std::tanh(weighted_sum / weight_sum),
        clamp(static_cast<double>(present) / 4.0 * volume_quality * clean_confidence, 0.0, 1.0)
    };
}

// This evolves a signed score, not a probability density. Distance is a return
// fraction, expiry is in days, and time is in minutes: diffusion coefficients
// have coordinate^2/minute units; drift has distance/minute units. Both ends
// use zero normal gradient (closed diffusive flux, constant ghost for drift).
struct ImplicitAxis {
    std::vector<double> left, right, inverse_pivot, lower_factor, upper_factor;

    ImplicitAxis(const std::vector<double>& coordinates, double diffusion, double drift)
        : left(coordinates.size(), 0.0), right(coordinates.size(), 0.0),
          inverse_pivot(coordinates.size()), lower_factor(coordinates.size()),
          upper_factor(coordinates.size()) {
        if (coordinates.empty() || !all_finite(coordinates) || !std::isfinite(diffusion)
            || diffusion < 0.0 || !std::isfinite(drift)) {
            throw std::runtime_error("PDE coordinates or coefficients are invalid");
        }
        for (std::size_t i = 1; i < coordinates.size(); ++i) {
            if (!(coordinates[i] > coordinates[i - 1])
                || !std::isfinite(coordinates[i] - coordinates[i - 1])) {
                throw std::runtime_error("PDE coordinates must be finite and strictly increasing");
            }
        }
        if (coordinates.size() == 1) return;
        for (std::size_t i = 0; i < coordinates.size(); ++i) {
            const double before = i > 0 ? coordinates[i] - coordinates[i - 1] : 0.0;
            const double after = i + 1 < coordinates.size() ? coordinates[i + 1] - coordinates[i] : 0.0;
            const double cell_width = 0.5 * before + 0.5 * after;
            if (i > 0) left[i] = (diffusion / cell_width + std::max(drift, 0.0)) / before;
            if (i + 1 < coordinates.size()) right[i] = (diffusion / cell_width + std::max(-drift, 0.0)) / after;
            if (!std::isfinite(left[i]) || !std::isfinite(right[i])) {
                throw std::runtime_error("PDE grid spacing exceeds the finite numerical range");
            }
        }
    }

    void factor(double dt) {
        double previous_gap = 1.0;
        for (std::size_t i = 0; i < left.size(); ++i) {
            const double lower = dt * left[i];
            const double upper = dt * right[i];
            // Avoid subtracting nearly equal large numbers in the Thomas
            // pivot: 1 + lower + upper - lower * previous_upper.
            const double remainder = 1.0 + lower * previous_gap;
            const double pivot = remainder + upper;
            if (!std::isfinite(pivot) || pivot <= 0.0) {
                throw std::runtime_error("PDE timestep and grid exceed the finite numerical range");
            }
            inverse_pivot[i] = 1.0 / pivot;
            lower_factor[i] = lower / pivot;
            upper_factor[i] = upper / pivot;
            previous_gap = remainder / pivot;
        }
    }

    void solve(std::vector<double>& field, int rows, int cols, bool distance_axis) const {
        const int length = distance_axis ? cols : rows;
        const int lines = distance_axis ? rows : cols;
        const int stride = distance_axis ? 1 : cols;
        for (int line = 0; line < lines; ++line) {
            const int start = distance_axis ? line * cols : line;
            field[start] *= inverse_pivot[0];
            for (int i = 1; i < length; ++i) {
                const int index = start + i * stride;
                field[index] = field[index] * inverse_pivot[i]
                    + lower_factor[i] * field[index - stride];
            }
            for (int i = length - 2; i >= 0; --i) {
                const int index = start + i * stride;
                field[index] += upper_factor[i] * field[index + stride];
            }
        }
    }
};

struct Evolution {
    std::vector<double> field;
    std::vector<double> scores;
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
    const std::vector<double>& horizons,
    bool retain_scores = false
) {
    const int size = checked_grid_size(expiries.size(), distances.size());
    const int rows = static_cast<int>(expiries.size());
    const int cols = static_cast<int>(distances.size());
    if (observed.size() != static_cast<std::size_t>(size) || weights.size() != observed.size()
        || !all_finite(observed) || !all_finite(weights) || !all_finite(distances) || !all_finite(expiries)
        || std::any_of(observed.begin(), observed.end(), [](double value) { return std::abs(value) > 1.0; })) {
        throw std::runtime_error("forecast field arrays or horizons are invalid");
    }
    if (!std::isfinite(decay) || decay < 0.0 || !std::isfinite(source_strength) || source_strength < 0.0
        || std::any_of(weights.begin(), weights.end(), [](double value) { return value < 0.0; })) {
        throw std::runtime_error("PDE reaction coefficients and weights must be finite and nonnegative");
    }
    const double dt = timestep_minutes;
    const int steps = checked_step_count(horizons, dt);
    constexpr long long max_work_items = 100'000'000;
    if (static_cast<long long>(size) * steps > max_work_items) {
        throw std::runtime_error("forecast workload exceeds the safety limit");
    }
    ImplicitAxis distance_axis(distances, distance_diffusion, distance_drift);
    ImplicitAxis expiry_axis(expiries, expiry_diffusion, 0.0);
    Evolution result;
    result.field = observed;
    result.integrals.resize(horizons.size());
    result.averages.resize(horizons.size());
    if (retain_scores) result.scores.reserve(steps + 1);
    // Normalize once: repeated scores need only a dot product, and even finite
    // near-DBL_MAX weights cannot overflow the weight sum. Preserve the public
    // EPS floor, including uniform weighting when all supplied weights are 0.
    std::vector<double> normalized_weights(weights.size());
    const double weight_scale = std::max(*std::max_element(weights.begin(), weights.end()), EPSILON);
    double weight_sum = 0.0;
    for (std::size_t i = 0; i < weights.size(); ++i) {
        normalized_weights[i] = std::max(weights[i], EPSILON) / weight_scale;
        weight_sum += normalized_weights[i];
    }
    for (double& weight : normalized_weights) weight /= weight_sum;
    const auto score_mean = [&]() {
        double value = 0.0;
        for (std::size_t i = 0; i < result.field.size(); ++i) {
            if (!std::isfinite(result.field[i])) throw std::runtime_error("PDE produced a non-finite score field");
            value += result.field[i] * normalized_weights[i];
        }
        return value;
    };
    std::vector<std::pair<double, std::size_t>> ordered_horizons;
    ordered_horizons.reserve(horizons.size());
    for (std::size_t i = 0; i < horizons.size(); ++i) ordered_horizons.emplace_back(horizons[i], i);
    std::sort(ordered_horizons.begin(), ordered_horizons.end());
    std::size_t next_horizon = 0;
    double previous_score = score_mean();
    if (retain_scores) result.scores.push_back(previous_score);
    double integrated = 0.0;
    double previous_time = 0.0;
    double factored_dt = -1.0;
    const double final_time = ordered_horizons.back().first;
    for (int step = 1; step <= steps; ++step) {
        const double time = step == steps ? final_time : std::min(step * dt, final_time);
        const double step_dt = time - previous_time;
        if (step_dt <= 0.0) continue;
        if (step_dt != factored_dt) {
            distance_axis.factor(step_dt);
            expiry_axis.factor(step_dt);
            factored_dt = step_dt;
        }
        const double denominator = 1.0 + step_dt * decay + step_dt * source_strength;
        if (!std::isfinite(denominator)) throw std::runtime_error("PDE reaction exceeds the finite numerical range");
        const double retained = 1.0 / denominator;
        const double sourced = (step_dt * source_strength) / denominator;
        for (int i = 0; i < size; ++i) {
            result.field[i] = retained * result.field[i] + sourced * observed[i];
        }
        // A product of backward-Euler resolvents is first-order consistent
        // with the original PDE and preserves its maximum principle, without
        // the grid-dependent explicit CFL limit or artificial score clipping.
        distance_axis.solve(result.field, rows, cols, true);
        expiry_axis.solve(result.field, rows, cols, false);
        const double score = score_mean();
        if (retain_scores) result.scores.push_back(score);
        while (next_horizon < ordered_horizons.size() && ordered_horizons[next_horizon].first <= time) {
            const auto [horizon, index] = ordered_horizons[next_horizon++];
            const double partial = horizon - previous_time;
            const double partial_score = previous_score + (score - previous_score) * (partial / step_dt);
            result.integrals[index] = integrated + 0.5 * (previous_score + partial_score) * partial;
            result.averages[index] = result.integrals[index] / horizon;
        }
        integrated += 0.5 * (previous_score + score) * step_dt;
        previous_score = score;
        previous_time = time;
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
        || row_pair_weight.size() != row_count || row_pair_variance.size() != row_count
        || !all_finite(row_expiry) || !all_finite(row_distance) || !all_finite(row_pair_signal)
        || !all_finite(row_pair_weight) || !all_finite(row_pair_variance)
        || !std::isfinite(spot) || spot <= 0.0 || !std::isfinite(volatility) || volatility < 0.0
        || !std::isfinite(trading_minutes_per_year) || trading_minutes_per_year <= 0.0) {
        throw std::runtime_error("forecast surface rows are invalid");
    }
    checked_step_count(horizons, timestep_minutes);
    Forecast result;
    result.distances = row_distance;
    result.expiries = row_expiry;
    std::sort(result.distances.begin(), result.distances.end());
    std::sort(result.expiries.begin(), result.expiries.end());
    result.distances.erase(std::unique(result.distances.begin(), result.distances.end()), result.distances.end());
    result.expiries.erase(std::unique(result.expiries.begin(), result.expiries.end()), result.expiries.end());
    const int size = checked_grid_size(result.expiries.size(), result.distances.size());
    const int cols = static_cast<int>(result.distances.size());
    const int rows = static_cast<int>(result.expiries.size());
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
    for (int row = 0; row < rows; ++row) {
        for (int col = 0; col < cols; ++col) {
            source_basis[row * cols + col] = std::exp(-std::abs(result.distances[col]) / 0.08)
                * std::exp(-result.expiries[row] / 45.0);
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
    Evolution evolution = evolve(
        observed, weights, result.distances, result.expiries,
        distance_diffusion, expiry_diffusion, distance_drift, decay, source_strength,
        timestep_minutes, horizons
    );
    result.field = std::move(evolution.field);
    result.integrals = std::move(evolution.integrals);
    result.averages = std::move(evolution.averages);
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
        composite_confidence * std::exp(-projected_factor_variance),
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
