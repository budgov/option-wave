#include <pybind11/numpy.h>
#include <pybind11/pybind11.h>
#include <pybind11/stl.h>

#include <algorithm>
#include <climits>
#include <cmath>
#include <initializer_list>
#include <limits>
#include <map>
#include <numeric>
#include <string>
#include <stdexcept>
#include <vector>

#include "ocean_wave_kernels.hpp"
#include "online_forecast.hpp"

namespace py = pybind11;
using DoubleArray = py::array_t<double, py::array::c_style | py::array::forcecast>;
using Index = py::ssize_t;
constexpr double EPS = 1e-12;
constexpr Index MAX_ARRAY_ELEMENTS = 10'000'000;
constexpr Index MAX_GRID_ELEMENTS = 1'000'000;

void validate_arrays(Index expected, std::initializer_list<const DoubleArray*> arrays) {
    if (expected < 0 || expected > static_cast<Index>(INT_MAX) || expected > MAX_ARRAY_ELEMENTS) {
        throw std::runtime_error("array length exceeds the supported range");
    }
    for (const DoubleArray* array : arrays) {
        if (array == nullptr || array->ndim() != 1 || array->size() != expected) {
            throw std::runtime_error("input arrays must be one-dimensional and have compatible lengths");
        }
    }
}

Index checked_product(Index left, Index right) {
    if (left <= 0 || right <= 0 || left > static_cast<Index>(INT_MAX) / right
        || left * right > MAX_GRID_ELEMENTS) {
        throw std::runtime_error("array grid dimensions are invalid or too large");
    }
    return left * right;
}

double clamp_value(double value, double low, double high) {
    return std::max(low, std::min(high, value));
}

bool solve_linear_system(std::vector<double> matrix, std::vector<double> rhs, int dimension, std::vector<double>& solution) {
    const std::size_t width = dimension > 0 ? static_cast<std::size_t>(dimension) : 0;
    if (dimension <= 0 || width > std::numeric_limits<std::size_t>::max() / width
        || matrix.size() != width * width || rhs.size() != width) {
        return false;
    }
    for (int pivot = 0; pivot < dimension; ++pivot) {
        int best = pivot;
        double best_value = std::abs(matrix[pivot * dimension + pivot]);
        for (int row = pivot + 1; row < dimension; ++row) {
            const double candidate = std::abs(matrix[row * dimension + pivot]);
            if (candidate > best_value) {
                best = row;
                best_value = candidate;
            }
        }
        if (best_value <= EPS || !std::isfinite(best_value)) return false;
        if (best != pivot) {
            for (int col = pivot; col < dimension; ++col) {
                std::swap(matrix[pivot * dimension + col], matrix[best * dimension + col]);
            }
            std::swap(rhs[pivot], rhs[best]);
        }
        const double diagonal = matrix[pivot * dimension + pivot];
        for (int row = pivot + 1; row < dimension; ++row) {
            const double multiplier = matrix[row * dimension + pivot] / diagonal;
            if (std::abs(multiplier) <= EPS) continue;
            matrix[row * dimension + pivot] = 0.0;
            for (int col = pivot + 1; col < dimension; ++col) {
                matrix[row * dimension + col] -= multiplier * matrix[pivot * dimension + col];
            }
            rhs[row] -= multiplier * rhs[pivot];
        }
    }
    solution.assign(dimension, 0.0);
    for (int row = dimension - 1; row >= 0; --row) {
        double value = rhs[row];
        for (int col = row + 1; col < dimension; ++col) {
            value -= matrix[row * dimension + col] * solution[col];
        }
        const double diagonal = matrix[row * dimension + row];
        if (std::abs(diagonal) <= EPS || !std::isfinite(diagonal)) return false;
        solution[row] = value / diagonal;
    }
    return true;
}

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

std::vector<double> to_vector(const DoubleArray& values) {
    validate_arrays(values.size(), {&values});
    const auto view = values.unchecked<1>();
    std::vector<double> result(values.size());
    for (Index i = 0; i < values.size(); ++i) result[static_cast<std::size_t>(i)] = view(i);
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

double energy_cost(double distance, double exponent, double min_distance) {
    const double d = std::max(std::abs(distance), min_distance);
    return std::pow(d, exponent);
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
    double variance_floor,
    double variance_scale,
    double expiry_decay_days
) {
    validate_arrays(strikes.size(), {
        &strikes, &expiries, &call_price, &put_price, &call_variance, &put_variance,
        &call_volume, &put_volume, &call_oi, &put_oi, &call_delta, &put_delta
    });
    if (strikes.size() < 2 || !std::isfinite(spot) || spot <= 0.0) {
        throw std::runtime_error("chain arrays are empty or spot is invalid");
    }
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
    for (Index i = 0; i < strikes.size(); ++i) {
        if (!std::isfinite(strike_view(i)) || !std::isfinite(expiry_view(i))) {
            throw std::runtime_error("strike and expiry arrays must contain finite values");
        }
        groups[expiry_view(i)].push_back(static_cast<int>(i));
    }
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
            const double pair_cost = energy_cost(distance, distance_exponent, min_distance);
            const double cf = cp / (pair_cost + EPS);
            const double pf = pp / (pair_cost + EPS);
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
    validate_arrays(call_force.size(), {
        &call_force, &put_force, &effective_score, &confidence, &prior_call, &prior_put
    });
    const auto cf = call_force.unchecked<1>();
    const auto pf = put_force.unchecked<1>();
    const auto actual = effective_score.unchecked<1>();
    const auto conf = confidence.unchecked<1>();
    const auto old_call = prior_call.unchecked<1>();
    const auto old_put = prior_put.unchecked<1>();
    std::vector<double> call_rating(call_force.size()), put_rating(call_force.size()), expected(call_force.size()), delta(call_force.size());
    for (Index i = 0; i < call_force.size(); ++i) {
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

py::dict aggregate_flow(
    const DoubleArray& notional,
    const DoubleArray& direction,
    const DoubleArray& confidence,
    const DoubleArray& age_minutes,
    const DoubleArray& large_mask,
    double half_life_minutes
) {
    validate_arrays(notional.size(), {&notional, &direction, &confidence, &age_minutes, &large_mask});
    const auto notional_view = notional.unchecked<1>();
    const auto direction_view = direction.unchecked<1>();
    const auto confidence_view = confidence.unchecked<1>();
    const auto age_view = age_minutes.unchecked<1>();
    const auto large_view = large_mask.unchecked<1>();
    const double half_life = std::max(half_life_minutes, 1e-6);
    const double log_two = std::log(2.0);
    double net = 0.0;
    double gross = 0.0;
    double large_net = 0.0;
    double large_gross = 0.0;
    double confidence_mass = 0.0;
    double recent_net = 0.0;
    double recent_gross = 0.0;
    double prior_net = 0.0;
    double prior_gross = 0.0;
    double large_count = 0.0;
    for (Index i = 0; i < notional.size(); ++i) {
        const double amount = std::max(notional_view(i), 0.0);
        const double signed_direction = std::max(-1.0, std::min(1.0, direction_view(i)));
        const double conf = std::max(0.0, std::min(1.0, confidence_view(i)));
        const double age = std::max(age_view(i), 0.0);
        const double decay = std::exp(-log_two * age / half_life);
        const double weighted = amount * conf * decay;
        const double signed_weighted = weighted * signed_direction;
        const bool is_large = large_view(i) > 0.0;
        net += signed_weighted;
        gross += weighted;
        confidence_mass += weighted * conf;
        if (is_large) {
            large_net += signed_weighted;
            large_gross += weighted;
            large_count += 1.0;
        }
        if (age <= half_life) {
            recent_net += signed_weighted;
            recent_gross += weighted;
        } else if (age <= 2.0 * half_life) {
            prior_net += signed_weighted;
            prior_gross += weighted;
        }
    }
    const double signal = std::tanh(net / std::max(gross, EPS));
    const double large_signal = std::tanh(large_net / std::max(large_gross, EPS));
    const double recent_ratio = recent_net / std::max(recent_gross, EPS);
    const double prior_ratio = prior_net / std::max(prior_gross, EPS);
    py::dict result;
    result["net_notional"] = net;
    result["gross_notional"] = gross;
    result["large_net_notional"] = large_net;
    result["large_gross_notional"] = large_gross;
    result["large_trade_count"] = large_count;
    result["signal"] = signal;
    result["large_signal"] = large_signal;
    result["velocity"] = std::tanh(recent_ratio - prior_ratio);
    result["confidence"] = confidence_mass / std::max(gross, EPS);
    return result;
}

py::dict aggregate_flow_risk(
    const DoubleArray& notional,
    const DoubleArray& direction,
    const DoubleArray& confidence,
    const DoubleArray& age_minutes,
    const DoubleArray& large_mask,
    const DoubleArray& contracts,
    const DoubleArray& delta,
    const DoubleArray& gamma,
    double spot,
    double half_life_minutes
) {
    const Index size = notional.size();
    validate_arrays(size, {
        &notional, &direction, &confidence, &age_minutes, &large_mask, &contracts, &delta, &gamma
    });
    py::dict result = aggregate_flow(notional, direction, confidence, age_minutes, large_mask, half_life_minutes);
    const auto direction_view = direction.unchecked<1>();
    const auto confidence_view = confidence.unchecked<1>();
    const auto age_view = age_minutes.unchecked<1>();
    const auto contracts_view = contracts.unchecked<1>();
    const auto delta_view = delta.unchecked<1>();
    const auto gamma_view = gamma.unchecked<1>();
    const double half_life = std::max(half_life_minutes, 1e-6);
    const double log_two = std::log(2.0);
    double delta_net = 0.0;
    double delta_gross = 0.0;
    double gamma_net = 0.0;
    double gamma_gross = 0.0;
    double greek_coverage = 0.0;
    for (Index i = 0; i < size; ++i) {
        const double contracts_value = std::max(contracts_view(i), 0.0);
        const double signed_direction = clamp_value(direction_view(i), -1.0, 1.0);
        const double conf = clamp_value(confidence_view(i), 0.0, 1.0);
        const double decay = std::exp(-log_two * std::max(age_view(i), 0.0) / half_life);
        const double weight = conf * decay;
        if (std::isfinite(delta_view(i))) {
            const double exposure = contracts_value * 100.0 * std::abs(delta_view(i)) * weight;
            delta_net += exposure * signed_direction;
            delta_gross += exposure;
            greek_coverage += weight;
        }
        if (std::isfinite(gamma_view(i)) && spot > 0.0) {
            const double exposure = contracts_value * 100.0 * std::abs(gamma_view(i)) * spot * spot * weight;
            gamma_net += exposure * signed_direction;
            gamma_gross += exposure;
        }
    }
    const double delta_ratio = delta_net / std::max(delta_gross, EPS);
    const double gamma_ratio = gamma_net / std::max(gamma_gross, EPS);
    result["delta_hedge_shares"] = delta_net;
    result["delta_hedge_gross_shares"] = delta_gross;
    result["gamma_notional"] = gamma_net;
    result["gamma_gross_notional"] = gamma_gross;
    result["hedge_signal"] = std::tanh(0.75 * delta_ratio + 0.25 * gamma_ratio);
    result["greek_coverage"] = size > 0 ? clamp_value(greek_coverage / static_cast<double>(size), 0.0, 1.0) : 0.0;
    return result;
}

py::dict extract_chain_factors(
    const DoubleArray& strikes,
    const DoubleArray& expiries,
    const DoubleArray& call_price,
    const DoubleArray& put_price,
    const DoubleArray& call_bid,
    const DoubleArray& call_ask,
    const DoubleArray& put_bid,
    const DoubleArray& put_ask,
    const DoubleArray& call_volume,
    const DoubleArray& put_volume,
    const DoubleArray& call_oi,
    const DoubleArray& put_oi,
    const DoubleArray& call_oi_change,
    const DoubleArray& put_oi_change,
    const DoubleArray& call_iv,
    const DoubleArray& put_iv,
    const DoubleArray& call_delta,
    const DoubleArray& put_delta,
    const DoubleArray& call_gamma,
    const DoubleArray& put_gamma,
    const DoubleArray& call_vega,
    const DoubleArray& put_vega,
    double spot,
    double realized_vol
) {
    const Index size = strikes.size();
    validate_arrays(size, {
        &strikes, &expiries, &call_price, &put_price, &call_bid, &call_ask, &put_bid, &put_ask,
        &call_volume, &put_volume, &call_oi, &put_oi, &call_oi_change, &put_oi_change,
        &call_iv, &put_iv, &call_delta, &put_delta, &call_gamma, &put_gamma, &call_vega, &put_vega
    });
    if (!std::isfinite(spot) || spot <= 0.0) {
        throw std::runtime_error("chain factor arrays have incompatible lengths or non-positive spot");
    }

    const auto strike = strikes.unchecked<1>();
    const auto expiry = expiries.unchecked<1>();
    const auto cp = call_price.unchecked<1>();
    const auto pp = put_price.unchecked<1>();
    const auto cb = call_bid.unchecked<1>();
    const auto ca = call_ask.unchecked<1>();
    const auto pb = put_bid.unchecked<1>();
    const auto pa = put_ask.unchecked<1>();
    const auto cv = call_volume.unchecked<1>();
    const auto pv = put_volume.unchecked<1>();
    const auto coi = call_oi.unchecked<1>();
    const auto poi = put_oi.unchecked<1>();
    const auto coic = call_oi_change.unchecked<1>();
    const auto poic = put_oi_change.unchecked<1>();
    const auto civ = call_iv.unchecked<1>();
    const auto piv = put_iv.unchecked<1>();
    const auto cd = call_delta.unchecked<1>();
    const auto pd = put_delta.unchecked<1>();
    const auto cg = call_gamma.unchecked<1>();
    const auto pg = put_gamma.unchecked<1>();
    const auto cvega = call_vega.unchecked<1>();
    const auto pvega = put_vega.unchecked<1>();

    double call_energy = 0.0;
    double put_energy = 0.0;
    double oi_change_net = 0.0;
    double oi_change_gross = 0.0;
    double net_gex = 0.0;
    double gross_gex = 0.0;
    double call_otm_iv_sum = 0.0;
    double call_otm_iv_weight = 0.0;
    double put_otm_iv_sum = 0.0;
    double put_otm_iv_weight = 0.0;
    double atm_iv_sum = 0.0;
    double atm_iv_weight = 0.0;
    double near_iv_sum = 0.0;
    double near_iv_weight = 0.0;
    double far_iv_sum = 0.0;
    double far_iv_weight = 0.0;
    double quote_quality_sum = 0.0;
    double quote_quality_weight = 0.0;
    double total_volume = 0.0;
    double oi_change_coverage = 0.0;
    double iv_coverage = 0.0;
    double gamma_coverage = 0.0;
    double delta_coverage = 0.0;
    double vega_coverage = 0.0;
    std::vector<double> normal_matrix(16, 0.0);
    std::vector<double> normal_rhs(4, 0.0);

    auto quote_quality = [](double bid, double ask, double price) {
        if (!std::isfinite(bid) || !std::isfinite(ask) || ask < bid || ask <= 0.0) return 0.0;
        const double mid = std::max(0.5 * (bid + ask), std::max(price, EPS));
        const double relative_spread = std::max(ask - bid, 0.0) / mid;
        return std::exp(-4.0 * relative_spread);
    };
    auto add_iv_sample = [&](double iv, double log_moneyness, double tau, double weight) {
        if (!std::isfinite(iv) || iv <= 0.0 || weight <= 0.0) return;
        const double feature[4] = {1.0, log_moneyness, log_moneyness * log_moneyness, std::sqrt(std::max(tau, 1.0 / 365.0))};
        for (int row = 0; row < 4; ++row) {
            normal_rhs[row] += weight * feature[row] * iv;
            for (int col = 0; col < 4; ++col) {
                normal_matrix[row * 4 + col] += weight * feature[row] * feature[col];
            }
        }
    };

    for (Index i = 0; i < size; ++i) {
        if (!std::isfinite(strike(i)) || strike(i) <= 0.0) continue;
        const double log_moneyness = std::log(strike(i) / spot);
        const double d = std::abs(log_moneyness);
        const double dte = std::max(std::isfinite(expiry(i)) ? expiry(i) : 0.0, 0.0);
        const double moneyness_weight = std::exp(-d / 0.08);
        const double expiry_weight = std::exp(-dte / 45.0);
        const double base_weight = moneyness_weight * expiry_weight;
        const double call_price_value = std::max(std::isfinite(cp(i)) ? cp(i) : 0.0, 0.0);
        const double put_price_value = std::max(std::isfinite(pp(i)) ? pp(i) : 0.0, 0.0);
        const double call_volume_value = std::max(std::isfinite(cv(i)) ? cv(i) : 0.0, 0.0);
        const double put_volume_value = std::max(std::isfinite(pv(i)) ? pv(i) : 0.0, 0.0);
        const double call_oi_value = std::max(std::isfinite(coi(i)) ? coi(i) : 0.0, 0.0);
        const double put_oi_value = std::max(std::isfinite(poi(i)) ? poi(i) : 0.0, 0.0);
        total_volume += call_volume_value + put_volume_value;

        const double call_delta_value = std::isfinite(cd(i)) ? std::abs(cd(i)) : 0.5;
        const double put_delta_value = std::isfinite(pd(i)) ? std::abs(pd(i)) : 0.5;
        call_energy += call_price_value * call_volume_value * 100.0 * call_delta_value * base_weight;
        put_energy += put_price_value * put_volume_value * 100.0 * put_delta_value * base_weight;
        if (std::isfinite(coic(i)) || std::isfinite(poic(i))) {
            const double call_change = std::isfinite(coic(i)) ? coic(i) * call_delta_value * base_weight : 0.0;
            const double put_change = std::isfinite(poic(i)) ? poic(i) * put_delta_value * base_weight : 0.0;
            oi_change_net += call_change - put_change;
            oi_change_gross += std::abs(call_change) + std::abs(put_change);
            oi_change_coverage += 1.0;
        }
        if (std::isfinite(cg(i)) || std::isfinite(pg(i))) {
            const double call_gex = call_oi_value * std::max(std::isfinite(cg(i)) ? std::abs(cg(i)) : 0.0, 0.0) * 100.0 * spot * spot * base_weight;
            const double put_gex = put_oi_value * std::max(std::isfinite(pg(i)) ? std::abs(pg(i)) : 0.0, 0.0) * 100.0 * spot * spot * base_weight;
            net_gex += call_gex - put_gex;
            gross_gex += call_gex + put_gex;
            gamma_coverage += 1.0;
        }
        if (std::isfinite(cd(i)) || std::isfinite(pd(i))) delta_coverage += 1.0;
        if (std::isfinite(cvega(i)) || std::isfinite(pvega(i))) vega_coverage += 1.0;

        const double call_quality = quote_quality(cb(i), ca(i), call_price_value);
        const double put_quality = quote_quality(pb(i), pa(i), put_price_value);
        const double activity_weight = 1.0 + std::log1p(call_volume_value + put_volume_value);
        quote_quality_sum += 0.5 * (call_quality + put_quality) * activity_weight;
        quote_quality_weight += activity_weight;

        const double iv_weight = base_weight * activity_weight;
        const bool call_iv_valid = std::isfinite(civ(i)) && civ(i) > 0.0;
        const bool put_iv_valid = std::isfinite(piv(i)) && piv(i) > 0.0;
        if (call_iv_valid || put_iv_valid) {
            const double mid_iv = call_iv_valid && put_iv_valid ? 0.5 * (civ(i) + piv(i)) : (call_iv_valid ? civ(i) : piv(i));
            add_iv_sample(mid_iv, log_moneyness, (dte + 1.0) / 365.0, iv_weight);
            const double atm_weight = std::exp(-d / 0.025) * expiry_weight * activity_weight;
            atm_iv_sum += mid_iv * atm_weight;
            atm_iv_weight += atm_weight;
            if (dte <= 7.0) {
                near_iv_sum += mid_iv * iv_weight;
                near_iv_weight += iv_weight;
            } else {
                far_iv_sum += mid_iv * iv_weight;
                far_iv_weight += iv_weight;
            }
            iv_coverage += 1.0;
        }
        if (strike(i) >= spot && call_iv_valid) {
            call_otm_iv_sum += civ(i) * iv_weight;
            call_otm_iv_weight += iv_weight;
        }
        if (strike(i) <= spot && put_iv_valid) {
            put_otm_iv_sum += piv(i) * iv_weight;
            put_otm_iv_weight += iv_weight;
        }
    }

    for (int diagonal = 0; diagonal < 4; ++diagonal) normal_matrix[diagonal * 4 + diagonal] += 1e-8;
    std::vector<double> coefficients(4, 0.0);
    solve_linear_system(normal_matrix, normal_rhs, 4, coefficients);
    const double energy_gross = call_energy + put_energy;
    const double energy_signal = std::tanh((call_energy - put_energy) / std::max(energy_gross, EPS));
    const bool has_oi_change = oi_change_coverage > 0.0;
    const bool directional_oi_change = has_oi_change && oi_change_gross > EPS;
    const double oi_signal = directional_oi_change
        ? std::tanh(oi_change_net / std::max(oi_change_gross, EPS))
        : 0.0;
    const double call_otm_iv = call_otm_iv_sum / std::max(call_otm_iv_weight, EPS);
    const double put_otm_iv = put_otm_iv_sum / std::max(put_otm_iv_weight, EPS);
    const bool has_two_sided_iv = call_otm_iv_weight > EPS && put_otm_iv_weight > EPS;
    const double iv_skew = has_two_sided_iv ? put_otm_iv - call_otm_iv : 0.0;
    const double iv_signal = has_two_sided_iv ? std::tanh(-iv_skew / 0.05) : 0.0;
    const double atm_iv = atm_iv_sum / std::max(atm_iv_weight, EPS);
    const double near_iv = near_iv_sum / std::max(near_iv_weight, EPS);
    const double far_iv = far_iv_sum / std::max(far_iv_weight, EPS);
    const double term_slope = (near_iv_weight > EPS && far_iv_weight > EPS) ? near_iv - far_iv : 0.0;
    const double vrp = (std::isfinite(realized_vol) && realized_vol > 0.0 && atm_iv_weight > EPS) ? atm_iv - realized_vol : 0.0;
    const double liquidity_quality = quote_quality_weight > EPS ? clamp_value(quote_quality_sum / quote_quality_weight, 0.0, 1.0) : 0.0;
    const double row_count = std::max(static_cast<double>(size), 1.0);
    // Keep the Python reference ordering: the final confidence is clipped,
    // not the activity term before it is multiplied by quote quality.
    const double activity_confidence = std::log1p(total_volume) / std::log(10001.0);

    py::dict result;
    result["energy_signal"] = energy_signal;
    result["energy_confidence"] = clamp_value(0.75 * activity_confidence * (0.35 + 0.65 * liquidity_quality), 0.0, 1.0);
    result["call_energy"] = call_energy;
    result["put_energy"] = put_energy;
    result["oi_signal"] = oi_signal;
    result["oi_confidence"] = clamp_value(
        directional_oi_change
            ? (0.55 + 0.45 * oi_change_coverage / row_count) * (0.4 + 0.6 * liquidity_quality)
            : 0.0,
        0.0,
        1.0
    );
    result["iv_surface_signal"] = iv_signal;
    result["iv_confidence"] = clamp_value((iv_coverage / row_count) * (0.4 + 0.6 * liquidity_quality), 0.0, 1.0);
    result["iv_skew"] = iv_skew;
    result["iv_level"] = atm_iv;
    result["iv_term_slope"] = term_slope;
    result["iv_curvature"] = coefficients[2];
    result["iv_moneyness_slope"] = coefficients[1];
    result["iv_time_slope"] = coefficients[3];
    result["volatility_risk_premium"] = vrp;
    result["gex_balance"] = std::tanh(net_gex / std::max(gross_gex, EPS));
    result["gex_net"] = net_gex;
    result["gex_gross"] = gross_gex;
    result["gex_confidence"] = clamp_value(0.6 * gamma_coverage / row_count, 0.0, 0.6);
    result["liquidity_quality"] = liquidity_quality;
    result["iv_coverage"] = clamp_value(iv_coverage / row_count, 0.0, 1.0);
    result["gamma_coverage"] = clamp_value(gamma_coverage / row_count, 0.0, 1.0);
    result["delta_coverage"] = clamp_value(delta_coverage / row_count, 0.0, 1.0);
    result["vega_coverage"] = clamp_value(vega_coverage / row_count, 0.0, 1.0);
    return result;
}

py::dict compute_short_factor(
    double short_interest_ratio,
    double short_interest_change,
    double short_volume_ratio,
    double borrow_fee,
    double utilization,
    double days_to_cover,
    double stock_signal,
    double data_confidence
) {
    const double values[6] = {short_interest_ratio, short_interest_change, short_volume_ratio, borrow_fee, utilization, days_to_cover};
    const double importance[6] = {0.15, 0.25, 0.20, 0.15, 0.15, 0.10};
    double pressure = 0.0;
    double weight_sum = 0.0;
    int present = 0;
    for (int i = 0; i < 6; ++i) {
        if (!std::isfinite(values[i])) continue;
        double feature = 0.0;
        if (i == 0) feature = std::tanh((values[i] - 0.10) / 0.15);
        else if (i == 1) feature = std::tanh(values[i] / 0.10);
        else if (i == 2) feature = std::tanh((values[i] - 0.50) / 0.20);
        else if (i == 3) feature = std::tanh(std::log1p(std::max(values[i], 0.0)) / 0.10);
        else if (i == 4) feature = std::tanh((values[i] - 0.50) / 0.25);
        else feature = std::tanh((values[i] - 2.0) / 3.0);
        pressure += importance[i] * feature;
        weight_sum += importance[i];
        present += 1;
    }
    pressure = weight_sum > EPS ? clamp_value(pressure / weight_sum, -1.0, 1.0) : 0.0;
    const double squeeze = 1.60 * std::max(pressure, 0.0) * std::max(stock_signal, 0.0);
    const double signal = clamp_value(-pressure + squeeze, -1.0, 1.0);
    py::dict result;
    result["signal"] = signal;
    result["pressure"] = pressure;
    result["squeeze"] = squeeze;
    result["confidence"] = clamp_value(data_confidence, 0.0, 1.0) * static_cast<double>(present) / 6.0;
    return result;
}

py::dict blend_factors(
    const DoubleArray& factors,
    const DoubleArray& confidences,
    const DoubleArray& priors,
    const DoubleArray& previous_mean,
    const DoubleArray& previous_covariance,
    double observation_count,
    double ewma_alpha,
    double ridge
) {
    const Index dimension = factors.size();
    validate_arrays(dimension, {&factors, &confidences, &priors, &previous_mean});
    const Index covariance_size = checked_product(dimension, dimension);
    if (previous_covariance.ndim() != 1 || previous_covariance.size() != covariance_size) {
        throw std::runtime_error("factor arrays have incompatible shapes");
    }
    const auto factor_view = factors.unchecked<1>();
    const auto confidence_view = confidences.unchecked<1>();
    const auto prior_view = priors.unchecked<1>();
    const auto mean_view = previous_mean.unchecked<1>();
    const auto covariance_view = previous_covariance.unchecked<1>();
    const double alpha = clamp_value(ewma_alpha, 1e-4, 1.0);
    std::vector<double> clean_factors(dimension), clean_confidence(dimension), mean(dimension), covariance(covariance_size);
    for (Index i = 0; i < dimension; ++i) {
        clean_confidence[i] = std::isfinite(confidence_view(i)) ? clamp_value(confidence_view(i), 0.0, 1.0) : 0.0;
        clean_factors[i] = std::isfinite(factor_view(i)) ? clamp_value(factor_view(i), -1.0, 1.0) : mean_view(i);
        mean[i] = std::isfinite(mean_view(i)) ? mean_view(i) : 0.0;
    }
    for (Index i = 0; i < covariance_size; ++i) {
        covariance[i] = std::isfinite(covariance_view(i)) ? covariance_view(i) : 0.0;
    }
    if (observation_count <= 0.0) {
        for (Index i = 0; i < dimension; ++i) {
            if (clean_confidence[i] > 0.0) mean[i] = clean_factors[i];
        }
    } else {
        std::vector<double> old_mean = mean;
        for (Index i = 0; i < dimension; ++i) {
            if (clean_confidence[i] > 0.0) mean[i] = (1.0 - alpha) * mean[i] + alpha * clean_factors[i];
        }
        for (Index row = 0; row < dimension; ++row) {
            for (Index col = 0; col < dimension; ++col) {
                const double innovation_row = clean_confidence[row] > 0.0 ? clean_factors[row] - old_mean[row] : 0.0;
                const double innovation_col = clean_confidence[col] > 0.0 ? clean_factors[col] - mean[col] : 0.0;
                covariance[row * dimension + col] = (1.0 - alpha) * covariance[row * dimension + col]
                    + alpha * innovation_row * innovation_col;
            }
        }
    }

    std::vector<double> system = covariance;
    std::vector<double> rhs(dimension, 0.0);
    for (Index i = 0; i < dimension; ++i) {
        system[i * dimension + i] += std::max(ridge, 1e-8);
        rhs[i] = std::max(std::isfinite(prior_view(i)) ? prior_view(i) : 0.0, 0.0) * clean_confidence[i];
    }
    std::vector<double> weights;
    if (!solve_linear_system(system, rhs, static_cast<int>(dimension), weights)) weights = rhs;
    double weight_sum = 0.0;
    for (Index i = 0; i < dimension; ++i) {
        weights[i] = std::isfinite(weights[i]) ? std::max(weights[i], 0.0) : 0.0;
        weight_sum += weights[i];
    }
    if (weight_sum <= EPS) {
        weights = rhs;
        weight_sum = std::accumulate(weights.begin(), weights.end(), 0.0);
    }
    if (weight_sum <= EPS) {
        weights.assign(dimension, 1.0 / static_cast<double>(dimension));
    } else {
        for (double& weight : weights) weight /= weight_sum;
    }
    double signal = 0.0;
    double confidence_value = 0.0;
    double projected_variance = 0.0;
    for (Index i = 0; i < dimension; ++i) {
        signal += weights[i] * clean_factors[i];
        confidence_value += weights[i] * clean_confidence[i];
        for (Index j = 0; j < dimension; ++j) {
            projected_variance += weights[i] * covariance[i * dimension + j] * weights[j];
        }
    }
    py::dict result;
    result["mean"] = to_array(mean);
    result["covariance"] = to_array(covariance);
    result["weights"] = to_array(weights);
    result["signal"] = clamp_value(signal, -1.0, 1.0);
    result["confidence"] = clamp_value(confidence_value, 0.0, 1.0);
    result["projected_variance"] = std::max(projected_variance, 0.0);
    result["count"] = observation_count + 1.0;
    return result;
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
    validate_arrays(observed_array.size(), {&observed_array, &weights_array});
    validate_arrays(distances_array.size(), {&distances_array});
    validate_arrays(expiries_array.size(), {&expiries_array});
    const Index checked_size = checked_product(expiries_array.size(), distances_array.size());
    if (observed_array.size() != checked_size) throw std::runtime_error("field arrays have incompatible shapes");
    const ocean_wave::Evolution evolution = ocean_wave::evolve(
        to_vector(observed_array),
        to_vector(weights_array),
        to_vector(distances_array),
        to_vector(expiries_array),
        distance_diffusion,
        expiry_diffusion,
        distance_drift,
        decay,
        source_strength,
        timestep_minutes,
        horizons,
        true
    );
    py::dict result;
    result["field"] = to_array(evolution.field);
    result["scores"] = to_array(evolution.scores);
    result["integrals"] = to_array(evolution.integrals);
    result["averages"] = to_array(evolution.averages);
    return result;
}

template <typename T, std::size_t Size>
py::array_t<double> to_array(const std::array<T, Size>& values) {
    py::array_t<double> result(Size);
    auto output = result.mutable_unchecked<1>();
    for (std::size_t i = 0; i < Size; ++i) output(static_cast<Index>(i)) = static_cast<double>(values[i]);
    return result;
}

py::dict aggregate_surface_signals(
    const DoubleArray& effective_score,
    const DoubleArray& confidence,
    const DoubleArray& elo_signal,
    const DoubleArray& pair_weight
) {
    const ocean_wave::SurfaceAggregate aggregate = ocean_wave::aggregate_surface(
        to_vector(effective_score),
        to_vector(confidence),
        to_vector(elo_signal),
        to_vector(pair_weight)
    );
    py::dict result;
    result["pair_signal"] = to_array(aggregate.pair_signal);
    result["premium_signal"] = aggregate.premium_signal;
    result["mean_pair_confidence"] = aggregate.mean_pair_confidence;
    return result;
}

py::dict compute_stock_confirmation(
    double spot,
    double previous_close,
    double vwap,
    double return_5m,
    double return_15m,
    double rvol,
    double realized_vol,
    double data_confidence
) {
    const ocean_wave::StockConfirmation confirmation = ocean_wave::stock_confirmation(
        spot, previous_close, vwap, return_5m, return_15m, rvol, realized_vol, data_confidence
    );
    py::dict result;
    result["signal"] = confirmation.signal;
    result["confidence"] = confirmation.confidence;
    return result;
}

py::dict forecast_surface(
    const DoubleArray& row_expiry,
    const DoubleArray& row_distance,
    const DoubleArray& row_pair_signal,
    const DoubleArray& row_pair_weight,
    const DoubleArray& row_pair_variance,
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
    const ocean_wave::Forecast forecast = ocean_wave::forecast_surface(
        to_vector(row_expiry),
        to_vector(row_distance),
        to_vector(row_pair_signal),
        to_vector(row_pair_weight),
        to_vector(row_pair_variance),
        composite_signal,
        composite_confidence,
        projected_factor_variance,
        spot,
        volatility,
        liquidity_quality,
        volatility_risk_premium,
        vrp_variance_scale,
        gamma_multiplier,
        trading_minutes_per_year,
        distance_diffusion,
        expiry_diffusion,
        distance_drift,
        decay,
        source_strength,
        timestep_minutes,
        horizons
    );
    py::dict result;
    result["distances"] = to_array(forecast.distances);
    result["expiries"] = to_array(forecast.expiries);
    result["field"] = to_array(forecast.field);
    result["integrals"] = to_array(forecast.integrals);
    result["averages"] = to_array(forecast.averages);
    result["expected_returns"] = to_array(forecast.expected_returns);
    result["expected_prices"] = to_array(forecast.expected_prices);
    result["return_variances"] = to_array(forecast.return_variances);
    result["price_variances"] = to_array(forecast.price_variances);
    result["probabilities_up"] = to_array(forecast.probabilities_up);
    result["current_field_signal"] = forecast.current_field_signal;
    result["trend_score"] = forecast.trend_score;
    result["confidence"] = forecast.confidence;
    result["median_distance"] = forecast.median_distance;
    return result;
}

py::dict extract_intraday_fourier_features(
    const py::array& returns_array,
    Index valid_length,
    Index max_harmonics,
    double sample_interval,
    bool linear_detrend,
    bool hann_taper
) {
    if (returns_array.ndim() != 1 || !returns_array.dtype().is(py::dtype::of<double>())
        || (returns_array.flags() & py::array::c_style) == 0) {
        throw std::runtime_error("intraday Fourier returns must be a one-dimensional C-contiguous float64 array");
    }
    if (returns_array.size() < 0
        || returns_array.size() > static_cast<Index>(ocean_wave::FOURIER_MAX_SAMPLES)
        || valid_length < static_cast<Index>(ocean_wave::FOURIER_MIN_SAMPLES)
        || valid_length > returns_array.size() || max_harmonics <= 0
        || max_harmonics > static_cast<Index>(ocean_wave::FOURIER_MAX_HARMONICS)) {
        throw std::runtime_error("intraday Fourier dimensions exceed the fixed safety bounds");
    }

    const auto typed_array = py::reinterpret_borrow<py::array_t<double>>(returns_array);
    const auto view = typed_array.unchecked<1>();
    std::vector<double> causal_returns(static_cast<std::size_t>(valid_length));
    for (Index index = 0; index < valid_length; ++index) {
        causal_returns[static_cast<std::size_t>(index)] = view(index);
    }

    ocean_wave::IntradayFourierFeatures features;
    {
        py::gil_scoped_release release;
        features = ocean_wave::extract_intraday_fourier(
            causal_returns,
            static_cast<std::size_t>(valid_length),
            static_cast<std::size_t>(max_harmonics),
            sample_interval,
            linear_detrend,
            hann_taper
        );
    }

    py::dict result;
    result["schema_version"] = "intraday_fourier.v2";
    result["feature_version"] = 2;
    result["causal_prefix"] = true;
    result["lookahead_samples"] = 0;
    result["window_alignment"] = "causal_prefix_ending_at_valid_length_minus_one";
    result["detrend_fit_interval"] = "causal_prefix_only";
    result["input_semantics"] = "equally_spaced_returns_causal_prefix";
    result["period_unit"] = "minutes";
    result["phase_convention"] = "x[n]=amplitude*cos(angle+phase)";
    result["amplitude_normalization"] = features.hann_taper ? "hann_coherent_gain" : "none";
    result["power_normalization"] = features.hann_taper ? "hann_mean_square_gain" : "none";
    result["detrend_strategy"] = features.linear_detrend ? "causal_ols_linear" : "causal_mean_only";
    result["taper_strategy"] = features.hann_taper ? "causal_prefix_hann" : "none";
    result["band_strategy"] = "fixed_period_minutes_v1";
    result["sample_count"] = features.sample_count;
    result["harmonic_count"] = features.harmonic_count;
    result["sample_interval"] = features.sample_interval;
    result["mean"] = features.mean;
    result["input_variance"] = features.input_variance;
    result["variance"] = features.variance;
    result["linear_detrend"] = features.linear_detrend;
    result["hann_taper"] = features.hann_taper;
    result["linear_trend_intercept"] = features.linear_trend_intercept;
    result["linear_trend_slope_per_sample"] = features.linear_trend_slope_per_sample;
    result["linear_trend_slope_per_minute"] = features.linear_trend_slope_per_sample / features.sample_interval;
    result["taper_coherent_gain"] = features.taper_coherent_gain;
    result["taper_power_gain"] = features.taper_power_gain;
    result["harmonics"] = to_array(features.harmonics);
    result["frequencies"] = to_array(features.frequencies);
    result["periods"] = to_array(features.periods);
    result["cosine_coefficients"] = to_array(features.cosine_coefficients);
    result["sine_coefficients"] = to_array(features.sine_coefficients);
    result["amplitudes"] = to_array(features.amplitudes);
    result["phases"] = to_array(features.phases);
    result["power"] = to_array(features.power);
    result["retained_energy"] = features.retained_energy;
    result["explained_energy_fraction"] = features.explained_energy_fraction;
    result["spectral_entropy"] = features.spectral_entropy;
    result["dominant_harmonic"] = features.dominant_harmonic;
    result["dominant_period"] = features.dominant_period;
    result["dominant_phase"] = features.dominant_phase;
    result["dominant_phase_sine"] = features.dominant_phase_sine;
    result["dominant_phase_cosine"] = features.dominant_phase_cosine;
    result["band_names"] = py::make_tuple("2_to_5m", "5_to_15m", "15_to_60m", "60_to_120m");
    result["band_period_lower_minutes"] = to_array(std::array<double, 4>{2.0, 5.0, 15.0, 60.0});
    result["band_period_upper_minutes"] = to_array(std::array<double, 4>{5.0, 15.0, 60.0, 120.0});
    result["band_upper_inclusive"] = py::make_tuple(false, false, false, true);
    result["band_energy"] = to_array(features.band_energy);
    result["band_energy_fraction"] = to_array(features.band_energy_fraction);
    result["out_of_band_energy"] = features.out_of_band_energy;
    result["out_of_band_energy_fraction"] = features.out_of_band_energy_fraction;
    result["band_covered_energy_fraction"] = features.band_covered_energy_fraction;
    return result;
}

py::dict online_forecast_predict(const std::vector<double>& packed_state,
    const std::vector<double>& stock, const std::vector<double>& options,
    double quality, double horizon_minutes) {
    ocean_wave::online::Prediction prediction;
    {
        py::gil_scoped_release release;
        prediction = ocean_wave::online::predict(ocean_wave::online::State::unpack(packed_state),
            stock, options, quality, horizon_minutes);
    }
    py::dict result;
    result["frozen_native"] = prediction.pack();
    result["expert_probabilities"] = prediction.probabilities;
    result["expert_weights"] = prediction.weights;
    result["probability_up"] = prediction.probability;
    result["expected_return"] = prediction.expected_return;
    result["return_scale"] = prediction.scale;
    result["interval_lower_return"] = prediction.lower_return;
    result["interval_upper_return"] = prediction.upper_return;
    result["interval_multiplier"] = prediction.interval_multiplier;
    result["trained_samples"] = prediction.trained_samples;
    result["option_quality"] = prediction.quality;
    result["change_score"] = prediction.change_score;
    return result;
}

py::dict online_forecast_learn(const std::vector<double>& packed_state,
    const std::vector<double>& frozen_forecast, double actual_return,
    bool replay = false, double horizon_minutes = 30.0) {
    ocean_wave::online::State state;
    {
        py::gil_scoped_release release;
        const auto prior = ocean_wave::online::State::unpack(packed_state);
        const auto frozen = ocean_wave::online::Prediction::unpack(frozen_forecast);
        state = replay ? ocean_wave::online::learn_replay(prior, frozen, actual_return, horizon_minutes)
            : ocean_wave::online::learn(prior, frozen, actual_return);
    }
    py::dict result;
    result["native_state"] = state.pack();
    result["trained_samples"] = state.samples;
    result["direction_score"] = state.direction_score;
    result["brier_sums"] = state.brier_sum;
    result["interval_hits"] = state.interval_hits;
    result["change_score"] = state.change_score;
    return result;
}

py::dict option_profit_probability(double spot, double mean_return, double return_variance,
    double delta, double gamma, double theta_pnl,
    double vega_per_vol_point, double iv_shock_vol_points, double round_trip_spread,
    double fees_per_share) {
    ocean_wave::online::OptionProfit profit;
    {
        py::gil_scoped_release release;
        profit = ocean_wave::online::option_profit_probability(spot, mean_return, return_variance,
            delta, gamma, theta_pnl, vega_per_vol_point,
            iv_shock_vol_points, round_trip_spread, fees_per_share);
    }
    py::dict result;
    result["available"] = true;
    result["approximation"] = "delta_gamma_normal";
    result["probability_profit"] = profit.probability_profit;
    result["expected_net_pnl"] = profit.expected_net_pnl;
    result["pnl_variance"] = profit.pnl_variance;
    result["pnl_unit"] = "per_underlying_share";
    return result;
}

PYBIND11_MODULE(_core, module) {
    module.doc() = "C++ numerical core for the Ocean Wave model";
    module.attr("ONLINE_FORECAST_VERSION") = "online_forecast.v1";
    module.attr("ONLINE_FORECAST_STATE_SIZE") = ocean_wave::online::State::SIZE;
    module.attr("ONLINE_FORECAST_FROZEN_SIZE") = ocean_wave::online::Prediction::SIZE;
    module.def("online_forecast_initial_state", [] { return ocean_wave::online::State{}.pack(); });
    module.def("online_forecast_validate_state", [](const std::vector<double>& state) {
        return ocean_wave::online::State::unpack(state).pack();
    });
    module.def("online_forecast_predict", &online_forecast_predict,
        py::arg("state"), py::arg("stock"), py::arg("options"), py::arg("quality"), py::arg("horizon_minutes"));
    module.def("online_forecast_learn", &online_forecast_learn,
        py::arg("state"), py::arg("frozen_forecast"), py::arg("actual_return"),
        py::arg("replay") = false, py::arg("horizon_minutes") = 30.0);
    module.def("option_profit_probability", &option_profit_probability,
        py::arg("spot"), py::arg("mean_return"), py::arg("return_variance"),
        py::arg("delta"), py::arg("gamma"), py::arg("theta_pnl"),
        py::arg("vega_per_vol_point"),
        py::arg("iv_shock_vol_points"), py::arg("round_trip_spread"), py::arg("fees_per_share"));
    module.attr("FOURIER_MIN_SAMPLES") = ocean_wave::FOURIER_MIN_SAMPLES;
    module.attr("FOURIER_MAX_SAMPLES") = ocean_wave::FOURIER_MAX_SAMPLES;
    module.attr("FOURIER_MAX_HARMONICS") = ocean_wave::FOURIER_MAX_HARMONICS;
    module.attr("FOURIER_BAND_COUNT") = ocean_wave::FOURIER_BAND_COUNT;
    module.def("build_pairs", &build_pairs);
    module.def("update_elo", &update_elo);
    module.def("aggregate_flow", &aggregate_flow);
    module.def("aggregate_flow_risk", &aggregate_flow_risk);
    module.def("extract_chain_factors", &extract_chain_factors);
    module.def("compute_short_factor", &compute_short_factor);
    module.def("blend_factors", &blend_factors);
    module.def("evolve_field", &evolve_field);
    module.def("aggregate_surface_signals", &aggregate_surface_signals);
    module.def("compute_stock_confirmation", &compute_stock_confirmation);
    module.def("forecast_surface", &forecast_surface);
    module.def(
        "extract_intraday_fourier",
        &extract_intraday_fourier_features,
        py::arg("returns").noconvert(),
        py::arg("valid_length").noconvert(),
        py::arg("max_harmonics").noconvert() = 64,
        py::arg("sample_interval") = 1.0,
        py::arg("linear_detrend").noconvert() = true,
        py::arg("hann_taper").noconvert() = true,
        R"doc(
Extract bounded Fourier features from the causal prefix of equally spaced returns.

Only ``returns[:valid_length]`` is observed. The explicit cut-off prevents a
preallocated buffer from leaking future observations. Periods and the fixed
2-5, 5-15, 15-60 and 60-120 bands use minutes. Causal OLS detrending and a Hann
taper are enabled by default and may be disabled explicitly for parity studies.
)doc"
    );
}
