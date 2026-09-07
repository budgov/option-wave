#pragma once

// Bounded, causal shadow forecaster. No Python objects, owned heap buffers or
// process-global state are retained by these numerical kernels.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <limits>
#include <stdexcept>
#include <vector>

namespace ocean_wave::online {

constexpr std::size_t STOCK_COUNT = 8;
// Eleven measured option-structure features, followed by seven cross-asset
// features. Premium ELO is a learned input, never a fixed percentage budget.
constexpr std::size_t OPTION_ONLY_COUNT = 11;
constexpr std::size_t CONTEXT_COUNT = 7;
constexpr std::size_t OPTION_COUNT = OPTION_ONLY_COUNT + CONTEXT_COUNT;
constexpr std::size_t FEATURE_COUNT = STOCK_COUNT + OPTION_COUNT;
constexpr std::size_t STOCK_DESIGN = 1 + 2 * STOCK_COUNT;
constexpr std::size_t OPTION_INTERACTIONS = 3;
constexpr std::size_t OPTION_DESIGN = 2 * OPTION_COUNT + OPTION_INTERACTIONS;
constexpr std::size_t EXPERT_COUNT = 5;
constexpr std::size_t CALIBRATION_CAPACITY = 256;
constexpr std::size_t MIN_SAMPLES = 32;
constexpr double COUNT_LIMIT = 1e9;
constexpr double HEDGE_ETA = 0.05;
constexpr double HEDGE_PRIOR_REVERSION = 0.001;
constexpr double HEDGE_LOG_MINIMUM = -8.0;
constexpr double CONDITIONAL_LOGIT_LIMIT = 4.0;
constexpr double MISSING_INDICATOR_SCALE = 0.25;

inline bool context_design(std::size_t index) {
    return index < 2 * OPTION_COUNT && index % OPTION_COUNT >= OPTION_ONLY_COUNT;
}

inline double bounded(double value, double low, double high) {
    return std::max(low, std::min(high, value));
}

inline double logistic(double value) {
    const double z = bounded(value, -20.0, 20.0);
    return 1.0 / (1.0 + std::exp(-z));
}

template <std::size_t N>
inline double dot(const std::array<double, N>& left, const std::array<double, N>& right) {
    double result = 0.0;
    for (std::size_t index = 0; index < N; ++index) result += left[index] * right[index];
    return result;
}

struct State {
    double samples = 0.0;
    std::array<double, FEATURE_COUNT> count{}, mean{}, m2{};
    std::array<double, STOCK_DESIGN> stock_weights{};
    std::array<double, OPTION_DESIGN> option_weights{};
    std::array<std::array<double, STOCK_DESIGN>, OPTION_COUNT> residual_weights{};
    std::array<double, EXPERT_COUNT> log_weights{}, brier_sum{};
    double direction_score = 0.0;
    double return_mean = 0.0;
    double return_variance = 0.0;
    double change_score = 0.0;
    double interval_alpha = 0.10;
    double interval_hits = 0.0;
    double calibration_count = 0.0;
    double calibration_cursor = 0.0;
    std::array<double, CALIBRATION_CAPACITY> calibration{};

    static constexpr std::size_t SIZE = 1 + 3 * FEATURE_COUNT + STOCK_DESIGN
        + OPTION_DESIGN + OPTION_COUNT * STOCK_DESIGN + 2 * EXPERT_COUNT + 8
        + CALIBRATION_CAPACITY;

    std::vector<double> pack() const {
        std::vector<double> result;
        result.reserve(SIZE);
        const auto append = [&result](const auto& values) {
            result.insert(result.end(), values.begin(), values.end());
        };
        result.push_back(samples);
        append(count); append(mean); append(m2); append(stock_weights); append(option_weights);
        for (const auto& row : residual_weights) append(row);
        append(log_weights); append(brier_sum);
        result.insert(result.end(), {direction_score, return_mean, return_variance,
            change_score, interval_alpha, interval_hits, calibration_count, calibration_cursor});
        append(calibration);
        return result;
    }

    static State unpack(const std::vector<double>& values) {
        if (values.size() != SIZE) throw std::runtime_error("online state has incompatible dimensions");
        for (const double value : values) {
            if (!std::isfinite(value) || std::abs(value) > 1e15) {
                throw std::runtime_error("online state contains invalid values");
            }
        }
        State state;
        std::size_t cursor = 0;
        const auto read = [&values, &cursor](auto& output) {
            std::copy_n(values.begin() + cursor, output.size(), output.begin());
            cursor += output.size();
        };
        state.samples = values[cursor++];
        read(state.count); read(state.mean); read(state.m2);
        read(state.stock_weights); read(state.option_weights);
        for (auto& row : state.residual_weights) read(row);
        read(state.log_weights); read(state.brier_sum);
        state.direction_score = values[cursor++];
        state.return_mean = values[cursor++];
        state.return_variance = values[cursor++];
        state.change_score = values[cursor++];
        state.interval_alpha = values[cursor++];
        state.interval_hits = values[cursor++];
        state.calibration_count = values[cursor++];
        state.calibration_cursor = values[cursor++];
        read(state.calibration);
        const auto integer_in = [](double value, double maximum) {
            return value >= 0.0 && value <= maximum && value == std::floor(value);
        };
        if (!integer_in(state.samples, COUNT_LIMIT)
            || !integer_in(state.calibration_count, CALIBRATION_CAPACITY)
            || !integer_in(state.calibration_cursor, CALIBRATION_CAPACITY - 1)
            || state.calibration_count > state.samples
            || state.return_variance < 0.0 || state.return_variance > 4.0
            || std::abs(state.return_mean) > 2.0
            || state.interval_alpha < 0.01 || state.interval_alpha > 0.25
            || state.change_score < 0.0 || state.change_score > 20.0
            || state.interval_hits < 0.0 || state.interval_hits > state.samples
            || std::abs(state.direction_score) > state.samples) {
            throw std::runtime_error("online state counters or calibration are invalid");
        }
        for (std::size_t index = 0; index < FEATURE_COUNT; ++index) {
            if (!integer_in(state.count[index], state.samples) || state.m2[index] < 0.0) {
                throw std::runtime_error("online feature statistics are invalid");
            }
        }
        for (const double loss : state.brier_sum) {
            if (loss < 0.0 || loss > state.samples + 1e-8) {
                throw std::runtime_error("online Brier accounting is invalid");
            }
        }
        for (const double weight : state.stock_weights) if (std::abs(weight) > 4.0) {
            throw std::runtime_error("online stock coefficient is invalid");
        }
        for (const double weight : state.option_weights) if (std::abs(weight) > 2.0) {
            throw std::runtime_error("online option coefficient is invalid");
        }
        for (const auto& row : state.residual_weights) for (const double weight : row) {
            if (std::abs(weight) > 4.0) throw std::runtime_error("online residual coefficient is invalid");
        }
        for (const double weight : state.log_weights) if (weight < -8.0 || weight > 0.0) {
            throw std::runtime_error("online expert weight is invalid");
        }
        for (const double value : state.calibration) if (value < 0.0 || value > 1e6) {
            throw std::runtime_error("online calibration score is invalid");
        }
        return state;
    }
};

struct Prediction {
    // raw[] is clipped to physical safety bounds; seen[] preserves missingness.
    std::array<double, FEATURE_COUNT> raw{}, seen{};
    std::array<double, STOCK_DESIGN> x{};
    std::array<double, OPTION_DESIGN> residual{};
    std::array<double, OPTION_COUNT> option_z{};
    std::array<double, EXPERT_COUNT> probabilities{}, weights{};
    // Explanations are pre-clip log-odds terms, not portfolio/factor weights.
    // They need not be packed for gradients; the JSON receipt digest freezes
    // the returned explanation alongside the packed numerical observation.
    std::array<double, STOCK_DESIGN> stock_logit_contributions{};
    std::array<double, OPTION_DESIGN> option_logit_contributions{};
    double stock_logit = 0.0;
    double option_logit_increment = 0.0;
    double context_logit_increment = 0.0;
    double option_feature_coverage = 0.0;
    double raw_stock_probability = 0.5;
    double raw_fused_probability = 0.5;
    double raw_context_probability = 0.5;
    double context_quality = 0.0;
    double quality = 0.0;
    double probability = 0.5;
    double expected_return = 0.0;
    double scale = 0.001;
    double lower_return = -0.002;
    double upper_return = 0.002;
    double trained_samples = 0.0;
    double change_score = 0.0;
    double interval_multiplier = 2.0;

    static constexpr std::size_t SIZE = 2 * FEATURE_COUNT + STOCK_DESIGN
        + OPTION_DESIGN + OPTION_COUNT + 2 * EXPERT_COUNT + 14;

    std::vector<double> pack() const {
        std::vector<double> result;
        result.reserve(SIZE);
        const auto append = [&result](const auto& values) {
            result.insert(result.end(), values.begin(), values.end());
        };
        append(raw); append(seen); append(x); append(residual); append(option_z);
        append(probabilities); append(weights);
        result.insert(result.end(), {raw_stock_probability, raw_fused_probability,
            quality, probability, expected_return, scale, lower_return, upper_return,
            trained_samples, change_score, interval_multiplier,
            raw_context_probability, context_quality, option_feature_coverage});
        return result;
    }

    static Prediction unpack(const std::vector<double>& values) {
        if (values.size() != SIZE) throw std::runtime_error("frozen forecast has incompatible dimensions");
        for (const double value : values) if (!std::isfinite(value) || std::abs(value) > 1e9) {
            throw std::runtime_error("frozen forecast contains invalid values");
        }
        Prediction p;
        std::size_t cursor = 0;
        const auto read = [&values, &cursor](auto& output) {
            std::copy_n(values.begin() + cursor, output.size(), output.begin());
            cursor += output.size();
        };
        read(p.raw); read(p.seen); read(p.x); read(p.residual); read(p.option_z);
        read(p.probabilities); read(p.weights);
        p.raw_stock_probability = values[cursor++]; p.raw_fused_probability = values[cursor++];
        p.quality = values[cursor++]; p.probability = values[cursor++];
        p.expected_return = values[cursor++]; p.scale = values[cursor++];
        p.lower_return = values[cursor++]; p.upper_return = values[cursor++];
        p.trained_samples = values[cursor++]; p.change_score = values[cursor++];
        p.interval_multiplier = values[cursor++];
        p.raw_context_probability = values[cursor++]; p.context_quality = values[cursor++];
        p.option_feature_coverage = values[cursor++];
        for (const double value : p.seen) if (value != 0.0 && value != 1.0) {
            throw std::runtime_error("frozen feature mask is invalid");
        }
        for (const double value : p.x) if (std::abs(value) > 4.0) {
            throw std::runtime_error("frozen stock design is invalid");
        }
        for (const double value : p.residual) if (std::abs(value) > 4.0) {
            throw std::runtime_error("frozen option design is invalid");
        }
        for (const double value : p.option_z) if (std::abs(value) > 4.0) {
            throw std::runtime_error("frozen option target is invalid");
        }
        for (const double value : p.probabilities) if (value < 0.0 || value > 1.0) {
            throw std::runtime_error("frozen probability is invalid");
        }
        if (p.x[0] != 1.0 || p.scale < 1e-5 || p.scale > 0.25
            || p.quality < 0.0 || p.quality > 1.0 || p.probability < 0.0 || p.probability > 1.0
            || p.raw_stock_probability < 0.0 || p.raw_stock_probability > 1.0
            || p.raw_fused_probability < 0.0 || p.raw_fused_probability > 1.0
            || p.raw_context_probability < 0.0 || p.raw_context_probability > 1.0
            || p.context_quality < 0.0 || p.context_quality > 1.0
            || p.option_feature_coverage < 0.0 || p.option_feature_coverage > 1.0
            || p.lower_return > p.upper_return || p.trained_samples < 0.0
            || p.trained_samples > COUNT_LIMIT || p.trained_samples != std::floor(p.trained_samples)
            || p.interval_multiplier < 0.5 || p.interval_multiplier > 25.0) {
            throw std::runtime_error("frozen forecast metadata is invalid");
        }
        return p;
    }
};

// Returns are decimal fractions. IV and realized_vol are annualized decimals.
// These ex-ante scale floors prevent tiny samples or flat histories amplifying noise.
constexpr std::array<double, FEATURE_COUNT> SCALE_FLOOR{
    0.002, 0.004, 0.003, 0.5, 0.002, 0.002, 0.10, 0.01,
    0.25, 0.25, 0.05, 0.15, 0.05, 1.0, 0.10, 0.25, 0.10, 0.20, 2.0,
    0.002, 0.004, 0.002, 2.0, 0.001, 0.5, 5.0
};
constexpr std::array<double, FEATURE_COUNT> INITIAL_MEAN{
    0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.25, 0.0,
    0.0, 0.75, 0.0, 0.25, 0.0, 0.0, 0.0, 0.0, 0.20, 0.75, 8.0,
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 20.0
};
constexpr std::array<double, FEATURE_COUNT> RAW_LIMIT{
    2.0, 2.0, 2.0, 1000.0, 2.0, 2.0, 10.0, 2.0,
    1.0, 1.0, 10.0, 10.0, 10.0, 100.0, 10.0, 1.0, 1.0, 1.0, 30.0,
    2.0, 2.0, 2.0, 500.0, 2.0, 100.0, 200.0
};

inline double normalize(const State& state, std::size_t index, double value) {
    const double mean = state.count[index] >= 8.0 ? state.mean[index] : INITIAL_MEAN[index];
    const double variance = state.count[index] >= 8.0
        ? state.m2[index] / (state.count[index] - 1.0) : 0.0;
    return bounded((value - mean) / std::max(std::sqrt(std::max(variance, 0.0)), SCALE_FLOOR[index]), -4.0, 4.0);
}

inline Prediction predict(const State& state, const std::vector<double>& stock,
    const std::vector<double>& options, double quality, double horizon_minutes) {
    if (stock.size() != STOCK_COUNT || options.size() != OPTION_COUNT
        || !std::isfinite(quality) || quality < 0.0 || quality > 1.0
        || !std::isfinite(horizon_minutes) || horizon_minutes < 1.0 || horizon_minutes > 390.0) {
        throw std::runtime_error("online input dimensions, horizon or quality are invalid");
    }
    Prediction p;
    p.x[0] = 1.0;
    std::size_t options_seen = 0;
    std::size_t context_seen = 0;
    for (std::size_t index = 0; index < FEATURE_COUNT; ++index) {
        const double value = index < STOCK_COUNT ? stock[index] : options[index - STOCK_COUNT];
        p.seen[index] = std::isfinite(value) ? 1.0 : 0.0;
        p.raw[index] = p.seen[index] ? bounded(value, -RAW_LIMIT[index], RAW_LIMIT[index]) : 0.0;
        const bool nonnegative = index == 3 || index == 6 || index == STOCK_COUNT + 1
            || index == STOCK_COUNT + 3 || index == STOCK_COUNT + 8
            || index == STOCK_COUNT + 9 || index == STOCK_COUNT + 10 || index == FEATURE_COUNT - 1;
        const bool unit_interval = index == STOCK_COUNT + 1 || index == STOCK_COUNT + 8 || index == STOCK_COUNT + 9;
        if ((nonnegative && value < 0.0) || (unit_interval && value > 1.0)) {
            p.seen[index] = 0.0; p.raw[index] = 0.0;
        }
        if (index < STOCK_COUNT) {
            p.x[index + 1] = p.seen[index] ? normalize(state, index, p.raw[index]) : 0.0;
            p.x[index + 1 + STOCK_COUNT] = MISSING_INDICATOR_SCALE * (1.0 - p.seen[index]);
        }
    }
    // ELO reliability must be measured, not guessed from option coverage. Its
    // scalar coefficient is learned; confidence only gates this observation.
    if (!p.seen[STOCK_COUNT + 1] || p.raw[STOCK_COUNT + 1] <= 0.0) {
        p.seen[STOCK_COUNT] = 0.0;
        p.raw[STOCK_COUNT] = 0.0;
    }
    for (std::size_t index = 0; index < OPTION_COUNT; ++index) {
        if (p.seen[STOCK_COUNT + index]) {
            if (index < OPTION_ONLY_COUNT) ++options_seen; else ++context_seen;
            p.option_z[index] = normalize(state, STOCK_COUNT + index, p.raw[STOCK_COUNT + index]);
            // Conditioning coefficients and scaler contain mature observations only.
            p.residual[index] = bounded(p.option_z[index] - dot(state.residual_weights[index], p.x), -4.0, 4.0);
        }
        p.residual[index + OPTION_COUNT] = MISSING_INDICATOR_SCALE * (1.0 - p.seen[STOCK_COUNT + index]);
    }
    if (p.seen[STOCK_COUNT]) p.residual[0] *= p.raw[STOCK_COUNT + 1];
    // Causal interactions: each requires its measured parents. No lookahead,
    // static dealer-position sign, or new synthetic measurement is introduced.
    if (p.seen[STOCK_COUNT] && p.seen[STOCK_COUNT + 2]) {
        p.residual[2 * OPTION_COUNT] = bounded(p.residual[0] * p.option_z[2], -4.0, 4.0);
    }
    if (p.seen[STOCK_COUNT] && p.seen[STOCK_COUNT + 8]) {
        p.residual[2 * OPTION_COUNT + 1] = bounded(p.residual[0] * p.raw[STOCK_COUNT + 8], -4.0, 4.0);
    }
    if (p.seen[0] && p.seen[STOCK_COUNT + 4]) {
        p.residual[2 * OPTION_COUNT + 2] = bounded(p.x[1] * p.option_z[4], -4.0, 4.0);
    }
    p.trained_samples = state.samples;
    const double shrink = state.samples / (state.samples + 32.0);
    p.option_feature_coverage = static_cast<double>(options_seen) / OPTION_ONLY_COUNT;
    // Coverage is diagnostic, not a second amplitude penalty. Absent fields
    // already disable their own values. New optional columns must not dilute
    // an existing valid ELO/IV measurement merely by enlarging a denominator.
    p.quality = options_seen > 0 ? quality : 0.0;
    p.context_quality = static_cast<double>(context_seen) / CONTEXT_COUNT;
    for (std::size_t index = 0; index < STOCK_DESIGN; ++index) {
        p.stock_logit_contributions[index] = state.stock_weights[index] * p.x[index];
    }
    p.stock_logit = bounded(dot(state.stock_weights, p.x), -4.0, 4.0);
    p.raw_stock_probability = logistic(p.stock_logit);
    double option_logit = 0.0, context_logit = 0.0;
    for (std::size_t index = 0; index < OPTION_DESIGN; ++index) {
        const double term = state.option_weights[index] * p.residual[index];
        const bool context = context_design(index);
        p.option_logit_contributions[index] = (context ? p.context_quality : p.quality) * term;
        if (context) context_logit += term;
        else option_logit += term;
    }
    p.option_logit_increment = p.quality * bounded(option_logit, -CONDITIONAL_LOGIT_LIMIT, CONDITIONAL_LOGIT_LIMIT);
    p.context_logit_increment = p.context_quality * bounded(context_logit, -CONDITIONAL_LOGIT_LIMIT, CONDITIONAL_LOGIT_LIMIT);
    p.raw_fused_probability = logistic(p.stock_logit + p.option_logit_increment);
    p.raw_context_probability = logistic(p.stock_logit + p.context_logit_increment);
    p.probabilities[0] = 0.5 + shrink * (p.raw_stock_probability - 0.5);
    p.probabilities[1] = 0.5 + shrink * (p.raw_fused_probability - 0.5);
    const double momentum = 0.65 * p.x[1] + 0.35 * p.x[2];
    p.probabilities[2] = 0.5 + shrink * (p.raw_context_probability - 0.5);
    p.probabilities[3] = 0.5 + 0.15 * shrink * std::tanh(momentum);
    p.probabilities[4] = 0.5 - 0.15 * shrink * std::tanh(p.x[3]);
    double total_weight = 0.0;
    for (std::size_t index = 0; index < EXPERT_COUNT; ++index) {
        p.weights[index] = std::exp(state.log_weights[index]);
        total_weight += p.weights[index];
    }
    p.probability = 0.0;
    for (std::size_t index = 0; index < EXPERT_COUNT; ++index) {
        // Frozen prequential Brier loss selects experts. Bounded log weights
        // and weak prior reversion allow recovery without a hard 10% floor.
        p.weights[index] /= total_weight;
        p.probability += p.weights[index] * p.probabilities[index];
    }
    const double realized = p.seen[6] ? bounded(p.raw[6], 0.01, 5.0) : 0.25;
    const double prior_scale = realized * std::sqrt(horizon_minutes / 98280.0);
    p.scale = bounded(std::sqrt((1.0 - shrink) * prior_scale * prior_scale
        + shrink * std::max(state.return_variance, 1e-10)), 1e-5, 0.25);
    p.expected_return = bounded((2.0 * p.probability - 1.0) * p.scale * 0.7978845608
        + 0.25 * shrink * state.return_mean, -0.25, 0.25);
    const auto count = static_cast<std::size_t>(state.calibration_count);
    if (count >= MIN_SAMPLES) {
        // A bounded rolling conformal score window. This is adaptive marginal
        // calibration, not a claim of exchangeability or conditional coverage.
        std::array<double, CALIBRATION_CAPACITY> scratch = state.calibration;
        const auto rank = std::min(count - 1, static_cast<std::size_t>(
            std::max(0.0, std::ceil((count + 1.0) * (1.0 - state.interval_alpha)) - 1.0)));
        std::nth_element(scratch.begin(), scratch.begin() + rank, scratch.begin() + count);
        p.interval_multiplier = bounded(scratch[rank], 0.5, 25.0);
    }
    p.lower_return = std::max(-0.99, p.expected_return - p.interval_multiplier * p.scale);
    p.upper_return = p.expected_return + p.interval_multiplier * p.scale;
    p.change_score = state.change_score;
    return p;
}

inline State learn(const State& prior, const Prediction& p, double actual_return) {
    if (!std::isfinite(actual_return) || actual_return < -1.0 || actual_return > 2.0) {
        throw std::runtime_error("actual return must be a finite decimal fraction in [-1, 2]");
    }
    if (prior.samples >= COUNT_LIMIT || p.trained_samples > prior.samples) {
        throw std::runtime_error("online state is exhausted or predates the frozen forecast");
    }
    State state = prior;
    // Match the runtime's +1/-1 rule: a flat outcome belongs to "not up".
    const double target = actual_return > 0.0 ? 1.0 : 0.0;
    const double rate = 0.04 / std::sqrt(1.0 + state.samples / 128.0);
    // L2-normalized SGD has bounded updates without squaring away the signal.
    // Only measured value terms set the scale; merely adding absent columns
    // must not suppress learning. Small explicit missing indicators remain
    // learnable, but are not confused with measured zeros.
    double stock_norm = 1.0;
    for (std::size_t index = 1; index <= STOCK_COUNT; ++index) stock_norm += p.x[index] * p.x[index];
    stock_norm = std::sqrt(stock_norm);
    for (std::size_t index = 0; index < STOCK_DESIGN; ++index) {
        const double gradient = (p.raw_stock_probability - target) * p.x[index] / stock_norm;
        const double regularizer = index == 0 ? 0.0 : 0.005 * state.stock_weights[index];
        state.stock_weights[index] = bounded(state.stock_weights[index] - rate * (gradient + regularizer), -4.0, 4.0);
    }
    double option_norm = 1.0, context_norm = 1.0;
    for (std::size_t index = 0; index < OPTION_DESIGN; ++index) {
        if (index >= OPTION_COUNT && index < 2 * OPTION_COUNT) continue;
        const double squared = p.residual[index] * p.residual[index];
        if (context_design(index)) context_norm += squared;
        else option_norm += squared;
    }
    option_norm = std::sqrt(option_norm);
    context_norm = std::sqrt(context_norm);
    for (std::size_t index = 0; index < OPTION_DESIGN; ++index) {
        const bool context = context_design(index);
        const double gate = context ? p.context_quality : p.quality;
        const double probability = context ? p.raw_context_probability : p.raw_fused_probability;
        const double gradient = gate * (probability - target) * p.residual[index]
            / (context ? context_norm : option_norm);
        state.option_weights[index] = bounded(state.option_weights[index]
            - rate * (gradient + 0.005 * state.option_weights[index]), -2.0, 2.0);
    }
    for (std::size_t option = 0; option < OPTION_COUNT; ++option) {
        const double gate = option < OPTION_ONLY_COUNT ? p.quality : p.context_quality;
        if (!p.seen[STOCK_COUNT + option] || gate <= 0.0) continue;
        const double residual_error = bounded(dot(state.residual_weights[option], p.x) - p.option_z[option], -4.0, 4.0);
        for (std::size_t index = 0; index < STOCK_DESIGN; ++index) {
            state.residual_weights[option][index] = bounded(state.residual_weights[option][index]
                - 0.08 * gate * (residual_error * p.x[index] / stock_norm
                    + 0.005 * state.residual_weights[option][index]), -4.0, 4.0);
        }
    }
    for (std::size_t index = 0; index < EXPERT_COUNT; ++index) {
        const double error = p.probabilities[index] - target;
        const double loss = error * error;
        state.brier_sum[index] += loss;
        // Prequential loss is genuinely out-of-sample at the issue timestamp.
        // A weak, explicit prior reversion lets formerly weak experts recover.
        // It does not impose a minimum expert percentage or promote a model.
        state.log_weights[index] = (1.0 - HEDGE_PRIOR_REVERSION) * state.log_weights[index] - HEDGE_ETA * loss;
    }
    const double maximum = *std::max_element(state.log_weights.begin(), state.log_weights.end());
    for (double& weight : state.log_weights) weight = bounded(weight - maximum, HEDGE_LOG_MINIMUM, 0.0);
    state.direction_score += ((p.probability > 0.5) == (target > 0.5)) ? 1.0 : -1.0;
    const double surprise = state.samples >= 8.0
        ? std::abs(actual_return - state.return_mean) / std::max(std::sqrt(state.return_variance), 1e-5) : 0.0;
    state.change_score = bounded(0.95 * state.change_score + 0.05 * std::max(0.0, surprise - 2.0), 0.0, 20.0);
    const double alpha = state.samples == 0.0 ? 1.0 : 0.04;
    const double error = actual_return - state.return_mean;
    state.return_mean += alpha * error;
    state.return_variance = (1.0 - alpha) * (state.return_variance + alpha * error * error);
    const bool covered = actual_return >= p.lower_return && actual_return <= p.upper_return;
    state.interval_hits += covered ? 1.0 : 0.0;
    state.interval_alpha = bounded(state.interval_alpha + 0.005 * (0.10 - (covered ? 0.0 : 1.0)), 0.01, 0.25);
    state.calibration[static_cast<std::size_t>(state.calibration_cursor)] =
        bounded(std::abs(actual_return - p.expected_return) / p.scale, 0.0, 1e6);
    state.calibration_cursor = std::fmod(state.calibration_cursor + 1.0, static_cast<double>(CALIBRATION_CAPACITY));
    state.calibration_count = std::min(state.calibration_count + 1.0, static_cast<double>(CALIBRATION_CAPACITY));
    for (std::size_t index = 0; index < FEATURE_COUNT; ++index) {
        if (!p.seen[index]) continue;
        if (index >= STOCK_COUNT && index < STOCK_COUNT + OPTION_ONLY_COUNT && p.quality <= 0.0) continue;
        if (index >= STOCK_COUNT + OPTION_ONLY_COUNT && p.context_quality <= 0.0) continue;
        state.count[index] += 1.0;
        const double delta = p.raw[index] - state.mean[index];
        state.mean[index] += delta / state.count[index];
        state.m2[index] = std::max(0.0, state.m2[index] + delta * (p.raw[index] - state.mean[index]));
    }
    state.samples += 1.0;
    return state;
}

inline State learn_replay(const State& state, const Prediction& frozen,
    double actual_return, double horizon_minutes) {
    const double missing = std::numeric_limits<double>::quiet_NaN();
    std::vector<double> stock(STOCK_COUNT), options(OPTION_COUNT);
    for (std::size_t index = 0; index < STOCK_COUNT; ++index) {
        stock[index] = frozen.seen[index] ? frozen.raw[index] : missing;
    }
    for (std::size_t index = 0; index < OPTION_COUNT; ++index) {
        const bool seen = frozen.seen[STOCK_COUNT + index] != 0.0;
        options[index] = seen ? frozen.raw[STOCK_COUNT + index] : missing;
    }
    // V3 stores evidence quality directly; coverage is a separate diagnostic.
    const double input_quality = frozen.quality;
    // Re-encoding happens at the label time, solely for gradient updates. It is
    // never represented as a newly issued historical forecast. This permits
    // overlapping horizons and rebuilding after invalid-session removal.
    auto learning = predict(state, stock, options, input_quality, horizon_minutes);
    learning.probabilities = frozen.probabilities;
    learning.weights = frozen.weights;
    learning.probability = frozen.probability;
    learning.expected_return = frozen.expected_return;
    learning.scale = frozen.scale;
    learning.lower_return = frozen.lower_return;
    learning.upper_return = frozen.upper_return;
    learning.interval_multiplier = frozen.interval_multiplier;
    return learn(state, learning, actual_return);
}

struct OptionProfit {
    double probability_profit = 0.0;
    double expected_net_pnl = 0.0;
    double pnl_variance = 0.0;
};

inline OptionProfit option_profit_probability(double spot, double mean_return,
    double return_variance, double delta, double gamma, double theta_pnl,
    double vega_per_vol_point, double iv_shock_vol_points,
    double round_trip_spread, double fees_per_share) {
    for (const double value : {spot, mean_return, return_variance, delta, gamma,
        theta_pnl, vega_per_vol_point, iv_shock_vol_points,
        round_trip_spread, fees_per_share}) {
        if (!std::isfinite(value)) throw std::runtime_error("option profit inputs must all be finite");
    }
    if (spot <= 0.0 || spot > 1e7 || return_variance < 0.0 || return_variance > 4.0
        || std::abs(mean_return) > 2.0 || std::abs(delta) > 1.0 || std::abs(gamma) > 1e4
        || std::abs(theta_pnl) > 1e7 || std::abs(vega_per_vol_point) > 1e7
        || std::abs(iv_shock_vol_points) > 1000.0
        || round_trip_spread < 0.0 || round_trip_spread > 1e7 || fees_per_share < 0.0 || fees_per_share > 1e7) {
        throw std::runtime_error("option profit inputs are outside supported units/ranges");
    }
    const double a = 0.5 * gamma * spot * spot;
    const double b = delta * spot;
    // Time-basis conversion belongs at the boundary: theta_pnl is already the
    // expected dollar change per underlying share over this holding interval.
    const double c = theta_pnl
        + vega_per_vol_point * iv_shock_vol_points - round_trip_spread - fees_per_share;
    OptionProfit result;
    result.expected_net_pnl = a * (mean_return * mean_return + return_variance) + b * mean_return + c;
    const double slope = b + 2.0 * a * mean_return;
    result.pnl_variance = 2.0 * a * a * return_variance * return_variance + slope * slope * return_variance;
    if (return_variance == 0.0) {
        result.probability_profit = result.expected_net_pnl > 0.0 ? 1.0 : 0.0;
        return result;
    }
    const double sd = std::sqrt(return_variance);
    const auto cdf = [mean_return, sd](double threshold) {
        return 0.5 * std::erfc(-(threshold - mean_return) / (sd * std::sqrt(2.0)));
    };
    if (a == 0.0) {
        result.probability_profit = b == 0.0 ? (c > 0.0 ? 1.0 : 0.0)
            : (b > 0.0 ? 1.0 - cdf(-c / b) : cdf(-c / b));
        return result;
    }
    const double discriminant = b * b - 4.0 * a * c;
    if (discriminant <= 0.0) {
        // With a continuous distribution an isolated zero has probability zero.
        result.probability_profit = a > 0.0 ? 1.0 : 0.0;
        return result;
    }
    const double root = std::sqrt(discriminant);
    const double q = -0.5 * (b + std::copysign(root, b));
    const double first = q / a;
    const double second = q == 0.0 ? -b / a : c / q;
    const double middle_mass = bounded(cdf(std::max(first, second)) - cdf(std::min(first, second)), 0.0, 1.0);
    result.probability_profit = a > 0.0 ? 1.0 - middle_mass : middle_mass;
    return result;
}

}  // namespace ocean_wave::online
