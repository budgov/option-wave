#include <pybind11/numpy.h>
#include <pybind11/pybind11.h>
#include <pybind11/stl.h>

#include <algorithm>
#include <cmath>
#include <map>
#include <string>
#include <stdexcept>
#include <vector>

namespace py = pybind11;
using DoubleArray = py::array_t<double, py::array::c_style | py::array::forcecast>;
constexpr double EPS = 1e-12;

double interpolate(const std::vector<double>& x, const std::vector<double>& y, double target) {
    if (x.empty()) return 0.0;
    if (target <= x.front()) return y.front();
    if (target >= x.back()) return y.back();
    auto upper = std::lower_bound(x.begin(), x.end(), target);
    const std::size_t hi = static_cast<std::size_t>(upper - x.begin());
    const std::size_t lo = hi - 1;
    const double span = x[hi] - x[lo];
    if (span <= EPS) return y[lo];
    const double weight = (target - x[lo]) / span;
    return y[lo] + weight * (y[hi] - y[lo]);
}

template <typename T>
py::array_t<double> to_array(const std::vector<T>& values) {
    py::array_t<double> result(values.size());
    auto output = result.mutable_unchecked<1>();
    for (std::size_t i = 0; i < values.size(); ++i) output(i) = static_cast<double>(values[i]);
    return result;
}

struct PairRow {
    double expiry_days;
    double distance_pct;
    double call_strike;
    double put_strike;
    double call_price;
    double put_price;
    double call_force;
    double put_force;
    double call_variance;
    double put_variance;
    double pair_variance;
    double confidence;
    double raw_score;
    double effective_score;
    double pair_weight;
    double call_volume;
    double put_volume;
    double call_oi;
    double put_oi;
    double call_delta;
    double put_delta;
};

double asymmetric_cost(double distance, bool upside, double exponent, double up_difficulty, double down_difficulty, double min_distance) {
    const double d = std::max(std::abs(distance), min_distance);
    const double difficulty = upside ? up_difficulty : down_difficulty;
    return std::pow(d, exponent) * std::exp(difficulty * d);
}

py::dict pair_dict(const std::vector<PairRow>& rows) {
    std::vector<double> expiry, distance, call_strike, put_strike, call_price, put_price;
    std::vector<double> call_force, put_force, call_variance, put_variance, pair_variance;
    std::vector<double> confidence, raw_score, effective_score, pair_weight;
    std::vector<double> call_volume, put_volume, call_oi, put_oi, call_delta, put_delta;
    expiry.reserve(rows.size());
    distance.reserve(rows.size());
    call_strike.reserve(rows.size());
    put_strike.reserve(rows.size());
    call_price.reserve(rows.size());
    put_price.reserve(rows.size());
    call_force.reserve(rows.size());
    put_force.reserve(rows.size());
    call_variance.reserve(rows.size());
    put_variance.reserve(rows.size());
    pair_variance.reserve(rows.size());
    confidence.reserve(rows.size());
    raw_score.reserve(rows.size());
    effective_score.reserve(rows.size());
    pair_weight.reserve(rows.size());
    call_volume.reserve(rows.size());
    put_volume.reserve(rows.size());
    call_oi.reserve(rows.size());
    put_oi.reserve(rows.size());
    call_delta.reserve(rows.size());
    put_delta.reserve(rows.size());

    for (const auto& row : rows) {
        expiry.push_back(row.expiry_days);
        distance.push_back(row.distance_pct);
        call_strike.push_back(row.call_strike);
        put_strike.push_back(row.put_strike);
        call_price.push_back(row.call_price);
        put_price.push_back(row.put_price);
        call_force.push_back(row.call_force);
        put_force.push_back(row.put_force);
        call_variance.push_back(row.call_variance);
        put_variance.push_back(row.put_variance);
        pair_variance.push_back(row.pair_variance);
        confidence.push_back(row.confidence);
        raw_score.push_back(row.raw_score);
        effective_score.push_back(row.effective_score);
        pair_weight.push_back(row.pair_weight);
        call_volume.push_back(row.call_volume);
        put_volume.push_back(row.put_volume);
        call_oi.push_back(row.call_oi);
        put_oi.push_back(row.put_oi);
        call_delta.push_back(row.call_delta);
        put_delta.push_back(row.put_delta);
    }

    py::dict result;
    result["expiry_days"] = to_array(expiry);
    result["distance_pct"] = to_array(distance);
    result["call_strike"] = to_array(call_strike);
    result["put_strike"] = to_array(put_strike);
    result["call_price"] = to_array(call_price);
    result["put_price"] = to_array(put_price);
    result["call_force"] = to_array(call_force);
    result["put_force"] = to_array(put_force);
    result["call_variance"] = to_array(call_variance);
    result["put_variance"] = to_array(put_variance);
    result["pair_variance"] = to_array(pair_variance);
    result["confidence"] = to_array(confidence);
    result["raw_score"] = to_array(raw_score);
    result["effective_score"] = to_array(effective_score);
    result["pair_weight"] = to_array(pair_weight);
    result["call_volume"] = to_array(call_volume);
    result["put_volume"] = to_array(put_volume);
    result["call_oi"] = to_array(call_oi);
    result["put_oi"] = to_array(put_oi);
    result["call_delta"] = to_array(call_delta);
    result["put_delta"] = to_array(put_delta);
    return result;
}

py::dict build_pairs(
    const DoubleArray& strikes,
    const DoubleArray& expiries,
    const DoubleArray& call_price,
    const DoubleArray& put_price,
    const DoubleArray& call_variance,
    const DoubleArray& put_variance,
    const DoubleArray& call_volume,
    const DoubleArray& put_volume,
    const DoubleArray& call_oi,
    const DoubleArray& put_oi,
    const DoubleArray& call_delta,
    const DoubleArray& put_delta,
    double spot,
    double min_distance,
    double distance_exponent,
    double up_difficulty,
    double down_difficulty,
    double variance_floor,
    double variance_scale,
    double expiry_decay_days
) {
    const auto strike_view = strikes.unchecked<1>();
    const auto expiry_view = expiries.unchecked<1>();
    const auto call_price_view = call_price.unchecked<1>();
    const auto put_price_view = put_price.unchecked<1>();
    const auto call_variance_view = call_variance.unchecked<1>();
    const auto put_variance_view = put_variance.unchecked<1>();
    const auto call_volume_view = call_volume.unchecked<1>();
    const auto put_volume_view = put_volume.unchecked<1>();
    const auto call_oi_view = call_oi.unchecked<1>();
    const auto put_oi_view = put_oi.unchecked<1>();
    const auto call_delta_view = call_delta.unchecked<1>();
    const auto put_delta_view = put_delta.unchecked<1>();

    std::map<double, std::vector<int>> groups;
    for (ssize_t i = 0; i < strikes.size(); ++i) groups[expiry_view(i)].push_back(static_cast<int>(i));
    std::vector<PairRow> rows;

    for (auto& group_entry : groups) {
        const double expiry_days = group_entry.first;
        auto indices = group_entry.second;
        std::sort(indices.begin(), indices.end(), [&](int left, int right) { return strike_view(left) < strike_view(right); });

        std::vector<double> x, c_price, p_price, c_var, p_var, c_volume, p_volume, c_oi, p_oi, c_delta, p_delta;
        x.reserve(indices.size());
        c_price.reserve(indices.size());
        p_price.reserve(indices.size());
        c_var.reserve(indices.size());
        p_var.reserve(indices.size());
        c_volume.reserve(indices.size());
        p_volume.reserve(indices.size());
        c_oi.reserve(indices.size());
        p_oi.reserve(indices.size());
        c_delta.reserve(indices.size());
        p_delta.reserve(indices.size());
        for (const int index : indices) {
            x.push_back(strike_view(index));
            c_price.push_back(std::max(call_price_view(index), EPS));
            p_price.push_back(std::max(put_price_view(index), EPS));
            c_var.push_back(std::max(call_variance_view(index), variance_floor));
            p_var.push_back(std::max(put_variance_view(index), variance_floor));
            c_volume.push_back(std::max(call_volume_view(index), 0.0));
            p_volume.push_back(std::max(put_volume_view(index), 0.0));
            c_oi.push_back(std::max(call_oi_view(index), 0.0));
            p_oi.push_back(std::max(put_oi_view(index), 0.0));
            c_delta.push_back(std::abs(call_delta_view(index)));
            p_delta.push_back(std::abs(put_delta_view(index)));
        }
        if (x.size() < 2 || x.front() > spot || x.back() < spot) continue;

        std::vector<double> up_distances, down_distances, candidates;
        for (const double strike : x) {
            if (strike >= spot) {
                const double d = (strike - spot) / spot;
                up_distances.push_back(d);
                candidates.push_back(d);
            }
            if (strike <= spot) {
                const double d = (spot - strike) / spot;
                down_distances.push_back(d);
                candidates.push_back(d);
            }
        }
        if (up_distances.empty() || down_distances.empty()) continue;
        const double max_distance = std::min(
            *std::max_element(up_distances.begin(), up_distances.end()),
            *std::max_element(down_distances.begin(), down_distances.end())
        );
        candidates.erase(std::remove_if(candidates.begin(), candidates.end(), [&](double value) { return value > max_distance + EPS; }), candidates.end());
        std::sort(candidates.begin(), candidates.end());
        candidates.erase(std::unique(candidates.begin(), candidates.end(), [](double left, double right) { return std::abs(left - right) < 1e-10; }), candidates.end());

        for (const double distance : candidates) {
            const double call_strike = spot * (1.0 + distance);
            const double put_strike = spot * (1.0 - distance);
            const double cp = interpolate(x, c_price, call_strike);
            const double pp = interpolate(x, p_price, put_strike);
            const double cv = interpolate(x, c_var, call_strike);
            const double pv = interpolate(x, p_var, put_strike);
            const double cvol = interpolate(x, c_volume, call_strike);
            const double pvol = interpolate(x, p_volume, put_strike);
            const double coi = interpolate(x, c_oi, call_strike);
            const double poi = interpolate(x, p_oi, put_strike);
            const double cd = interpolate(x, c_delta, call_strike);
            const double pd = interpolate(x, p_delta, put_strike);
            const double call_cost = asymmetric_cost(distance, true, distance_exponent, up_difficulty, down_difficulty, min_distance);
            const double put_cost = asymmetric_cost(distance, false, distance_exponent, up_difficulty, down_difficulty, min_distance);
            const double cf = cp / (call_cost + EPS);
            const double pf = pp / (put_cost + EPS);
            const double raw = cf / (cf + pf + EPS);
            const double pair_var = std::max(cv + pv, variance_floor);
            const double pair_confidence = 1.0 / (1.0 + pair_var / std::max(variance_scale, EPS));
            const double effective = 0.5 + (raw - 0.5) * pair_confidence;
            const double activity = 1.0 + std::log1p(cvol + pvol);
            const double liquidity = activity / (1.0 + std::log1p(coi + poi + EPS));
            const double weight = pair_confidence * std::exp(-expiry_decay_days * expiry_days) * std::max(liquidity, 0.1);
            rows.push_back({
                expiry_days, distance, call_strike, put_strike, cp, pp, cf, pf,
                cv, pv, pair_var, pair_confidence, raw, effective, weight,
                cvol, pvol, coi, poi, cd, pd
            });
        }
    }
    if (rows.empty()) throw std::runtime_error("chain must contain strikes on both sides of spot for at least one expiry");
    return pair_dict(rows);
}

py::dict update_elo(
    const DoubleArray& call_force,
    const DoubleArray& put_force,
    const DoubleArray& effective_score,
    const DoubleArray& confidence,
    const DoubleArray& prior_call,
    const DoubleArray& prior_put,
    double base_rating,
    double rating_scale,
    double k_factor
) {
    const auto cf = call_force.unchecked<1>();
    const auto pf = put_force.unchecked<1>();
    const auto actual = effective_score.unchecked<1>();
    const auto conf = confidence.unchecked<1>();
    const auto old_call = prior_call.unchecked<1>();
    const auto old_put = prior_put.unchecked<1>();
    std::vector<double> call_rating(call_force.size()), put_rating(call_force.size()), expected(call_force.size()), delta(call_force.size());
    for (ssize_t i = 0; i < call_force.size(); ++i) {
        const double force_ratio = std::max(cf(i), EPS) / std::max(pf(i), EPS);
        const double confidence_value = conf(i);
        double c_rating;
        double p_rating;
        if (!std::isfinite(old_call(i)) || !std::isfinite(old_put(i))) {
            const double prior_gap = rating_scale * std::log10(force_ratio) * confidence_value;
            c_rating = base_rating + 0.5 * prior_gap;
            p_rating = base_rating - 0.5 * prior_gap;
        } else {
            c_rating = old_call(i);
            p_rating = old_put(i);
        }
        const double exponent = std::max(-50.0, std::min(50.0, (p_rating - c_rating) / std::max(rating_scale, EPS)));
        const double expected_call = 1.0 / (1.0 + std::pow(10.0, exponent));
        const double rating_delta = k_factor * confidence_value * (actual(i) - expected_call);
        c_rating += rating_delta;
        p_rating -= rating_delta;
        call_rating[i] = c_rating;
        put_rating[i] = p_rating;
        expected[i] = expected_call;
        delta[i] = rating_delta;
    }
    py::dict result;
    result["call_elo"] = to_array(call_rating);
    result["put_elo"] = to_array(put_rating);
    result["expected_call_score"] = to_array(expected);
    result["elo_delta"] = to_array(delta);
    return result;
}

double weighted_mean(const std::vector<double>& values, const std::vector<double>& weights) {
    double numerator = 0.0;
    double denominator = 0.0;
    for (std::size_t i = 0; i < values.size(); ++i) {
        const double weight = std::max(weights[i], EPS);
        numerator += values[i] * weight;
        denominator += weight;
    }
    return denominator > EPS ? numerator / denominator : 0.0;
}

void gradient_axis(const std::vector<double>& field, int rows, int cols, const std::vector<double>& coordinates, int axis, std::vector<double>& output) {
    output.assign(field.size(), 0.0);
    if ((axis == 0 && rows < 2) || (axis == 1 && cols < 2)) return;
    for (int row = 0; row < rows; ++row) {
        for (int col = 0; col < cols; ++col) {
            const int index = row * cols + col;
            if (axis == 1) {
                if (col == 0) {
                    const double span = coordinates[1] - coordinates[0];
                    output[index] = span > EPS ? (field[row * cols + 1] - field[index]) / span : 0.0;
                } else if (col == cols - 1) {
                    const double span = coordinates[cols - 1] - coordinates[cols - 2];
                    output[index] = span > EPS ? (field[index] - field[row * cols + cols - 2]) / span : 0.0;
                } else {
                    const double left_span = coordinates[col] - coordinates[col - 1];
                    const double right_span = coordinates[col + 1] - coordinates[col];
                    const double denominator = left_span * right_span * (left_span + right_span);
                    output[index] = denominator > EPS
                        ? (-right_span * right_span * field[row * cols + col - 1]
                           + (right_span * right_span - left_span * left_span) * field[index]
                           + left_span * left_span * field[row * cols + col + 1]) / denominator
                        : 0.0;
                }
            } else {
                if (row == 0) {
                    const double span = coordinates[1] - coordinates[0];
                    output[index] = span > EPS ? (field[cols + col] - field[index]) / span : 0.0;
                } else if (row == rows - 1) {
                    const double span = coordinates[rows - 1] - coordinates[rows - 2];
                    output[index] = span > EPS ? (field[index] - field[(rows - 2) * cols + col]) / span : 0.0;
                } else {
                    const double top_span = coordinates[row] - coordinates[row - 1];
                    const double bottom_span = coordinates[row + 1] - coordinates[row];
                    const double denominator = top_span * bottom_span * (top_span + bottom_span);
                    output[index] = denominator > EPS
                        ? (-bottom_span * bottom_span * field[(row - 1) * cols + col]
                           + (bottom_span * bottom_span - top_span * top_span) * field[index]
                           + top_span * top_span * field[(row + 1) * cols + col]) / denominator
                        : 0.0;
                }
            }
        }
    }
}

std::vector<double> laplacian_axis(const std::vector<double>& field, int rows, int cols, const std::vector<double>& coordinates, int axis) {
    std::vector<double> gradient;
    std::vector<double> laplacian;
    gradient_axis(field, rows, cols, coordinates, axis, gradient);
    gradient_axis(gradient, rows, cols, coordinates, axis, laplacian);
    return laplacian;
}

py::dict evolve_field(
    const DoubleArray& observed_array,
    const DoubleArray& weights_array,
    const DoubleArray& distances_array,
    const DoubleArray& expiries_array,
    double distance_diffusion,
    double expiry_diffusion,
    double distance_drift,
    double decay,
    double source_strength,
    double timestep_minutes,
    const std::vector<double>& horizons
) {
    const auto observed_view = observed_array.unchecked<1>();
    const auto weights_view = weights_array.unchecked<1>();
    const auto distance_view = distances_array.unchecked<1>();
    const auto expiry_view = expiries_array.unchecked<1>();
    const int rows = static_cast<int>(expiries_array.size());
    const int cols = static_cast<int>(distances_array.size());
    const int size = rows * cols;
    if (observed_array.size() != size || weights_array.size() != size) throw std::runtime_error("field arrays have incompatible shapes");
    const double dt = std::max(timestep_minutes, 1e-6);
    const double max_horizon = *std::max_element(horizons.begin(), horizons.end());
    const int steps = static_cast<int>(std::ceil(max_horizon / dt));
    std::vector<double> distances(cols), expiries(rows), observed(size), weights(size), field(size), next(size), scores(steps + 1);
    for (int i = 0; i < cols; ++i) distances[i] = distance_view(i);
    for (int i = 0; i < rows; ++i) expiries[i] = expiry_view(i);
    for (int i = 0; i < size; ++i) {
        observed[i] = observed_view(i);
        weights[i] = weights_view(i);
        field[i] = observed[i];
    }
    scores[0] = weighted_mean(field, weights);
    for (int step = 1; step <= steps; ++step) {
        const std::vector<double> lap_distance = laplacian_axis(field, rows, cols, distances, 1);
        const std::vector<double> lap_expiry = laplacian_axis(field, rows, cols, expiries, 0);
        std::vector<double> gradient_distance;
        gradient_axis(field, rows, cols, distances, 1, gradient_distance);
        for (int i = 0; i < size; ++i) {
            const double derivative = -distance_drift * gradient_distance[i]
                + distance_diffusion * lap_distance[i]
                + expiry_diffusion * lap_expiry[i]
                - decay * field[i]
                + source_strength * (observed[i] - field[i]);
            next[i] = std::max(-1.0, std::min(1.0, field[i] + dt * derivative));
        }
        field.swap(next);
        scores[step] = weighted_mean(field, weights);
    }
    std::vector<double> integrals, averages;
    integrals.reserve(horizons.size());
    averages.reserve(horizons.size());
    for (const double horizon : horizons) {
        const int index = std::min(steps, static_cast<int>(std::ceil(horizon / dt)));
        double integral = 0.0;
        for (int i = 1; i <= index; ++i) integral += 0.5 * (scores[i] + scores[i - 1]) * dt;
        const double elapsed = std::max(index * dt, EPS);
        integrals.push_back(integral);
        averages.push_back(integral / elapsed);
    }
    py::dict result;
    result["field"] = to_array(field);
    result["scores"] = to_array(scores);
    result["integrals"] = to_array(integrals);
    result["averages"] = to_array(averages);
    return result;
}

PYBIND11_MODULE(_core, module) {
    module.doc() = "C++ numerical core for Option Wave v0.9";
    module.def("build_pairs", &build_pairs);
    module.def("update_elo", &update_elo);
    module.def("evolve_field", &evolve_field);
}
