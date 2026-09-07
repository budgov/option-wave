#include "../cpp/online_forecast.hpp"

#include <chrono>
#include <iostream>
#include <limits>
#include <stdexcept>

namespace {
void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}
template <typename Function>
void require_throws(Function&& callable, const char* message) {
    try { callable(); } catch (const std::runtime_error&) { return; }
    throw std::runtime_error(message);
}
}  // namespace

int main() {
    using namespace ocean_wave::online;
    const double missing = std::numeric_limits<double>::quiet_NaN();
    const std::vector<double> stock{0.004, 0.008, 0.003, 1.5, 0.002, missing, 0.35, 0.01};
    const std::vector<double> options{
        0.3, 0.9, 0.05, 0.30, 0.02, 0.1, 0.03, 0.2, 0.4, 0.8, 9.0,
        -0.001, missing, 0.002, 1.0, 0.001, -0.2, 20.0};
    State state;
    require(state.pack().size() == State::SIZE, "native state size");
    require(State::unpack(state.pack()).pack() == state.pack(), "empty state roundtrip");
    const auto first = predict(state, stock, options, 0.8, 30.0);
    require(first.pack().size() == Prediction::SIZE, "native receipt size");
    require(Prediction::unpack(first.pack()).pack() == first.pack(), "receipt roundtrip");
    require(first.probability == 0.5, "untrained prior must be neutral");
    constexpr std::size_t missing_inverse = STOCK_COUNT + OPTION_ONLY_COUNT + 1;
    require(first.seen[5] == 0.0 && first.seen[missing_inverse] == 0.0, "missing masks must survive");
    require(first.raw[missing_inverse] == 0.0 && first.residual[OPTION_ONLY_COUNT + 1] == 0.0,
        "missing inverse reference cannot fabricate a signal");
    require(first.option_feature_coverage == 1.0 && first.quality == 0.8,
        "quality and measured-feature coverage are separate");
    const auto packed_before = state.pack();
    for (int index = 0; index < 10; ++index) predict(state, stock, options, 0.8, 30.0);
    require(state.pack() == packed_before, "prediction must not update any normalizer or learner");
    const auto started = std::chrono::steady_clock::now();
    for (int index = 0; index < 3000; ++index) {
        const auto forecast = predict(state, stock, options, 0.8, 30.0);
        state = learn(state, forecast, 0.005 + 0.002 * std::sin(static_cast<double>(index)));
    }
    const auto elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    const auto fitted = predict(state, stock, options, 0.8, 30.0);
    require(fitted.probabilities[0] > 0.55, "stock logistic must learn mature labels");
    require(fitted.probability > 0.5, "ensemble must respond to observed outcomes");
    require(state.calibration_count == CALIBRATION_CAPACITY, "calibration memory must stay bounded");
    require(state.pack().size() == State::SIZE, "model memory must stay fixed");
    require(State::unpack(state.pack()).pack() == state.pack(), "trained state roundtrip");
    double weight_sum = 0.0;
    for (const double weight : fitted.weights) {
        require(std::isfinite(weight) && weight > 0.0 && weight < 1.0, "bounded Hedge has no fixed expert floor");
        weight_sum += weight;
    }
    require(std::abs(weight_sum - 1.0) < 1e-12, "Hedge weights must sum to one");
    const auto no_options = predict(state, stock, std::vector<double>(OPTION_COUNT, missing), 1.0, 30.0);
    require(no_options.probabilities[0] == no_options.probabilities[1], "missing options cannot alter stock odds");
    require(no_options.probabilities[0] == no_options.probabilities[2], "missing context cannot alter stock odds");
    require(state.count[STOCK_COUNT + OPTION_ONLY_COUNT] > 0.0, "context normalizers learn mature observations");
    std::vector<double> elo_only(OPTION_COUNT, missing);
    elo_only[0] = 0.7;
    elo_only[1] = 1.0;
    const auto elo_sparse = predict(state, stock, elo_only, 0.8, 30.0);
    require(elo_sparse.quality == 0.8, "missing optional columns must not dilute ELO quality");
    require(std::abs(elo_sparse.option_feature_coverage - 2.0 / OPTION_ONLY_COUNT) < 1e-12,
        "sparse option coverage denominator follows the measured schema");
    require(elo_sparse.residual[2 * OPTION_COUNT] == 0.0
        && elo_sparse.residual[2 * OPTION_COUNT + 1] == 0.0
        && elo_sparse.residual[2 * OPTION_COUNT + 2] == 0.0,
        "interactions with missing parents must be absent");
    elo_only[1] = missing;
    const auto elo_unverified = predict(state, stock, elo_only, 0.8, 30.0);
    require(elo_unverified.seen[STOCK_COUNT] == 0.0,
        "missing ELO confidence cannot become synthetic reliability");
    const auto untrusted = predict(state, stock, options, 0.0, 30.0);
    require(untrusted.probabilities[0] == untrusted.probabilities[1], "zero-quality options cannot alter stock odds");
    const auto frozen = first.pack();
    auto replay = learn(state, Prediction::unpack(frozen), -0.01);
    require(first.pack() == frozen, "feedback must not mutate the original forecast");
    require(replay.samples == state.samples + 1.0, "learn increments one sample");
    const auto prior_loss = state.brier_sum;
    for (std::size_t index = 0; index < EXPERT_COUNT; ++index) {
        require(std::abs((replay.brier_sum[index] - prior_loss[index]) - 0.25) < 1e-10,
            "Brier accounting must use issue-time probabilities");
    }
    const auto linear = option_profit_probability(100.0, 0.0, 0.0001,
        0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    require(std::abs(linear.probability_profit - 0.5) < 1e-12, "linear zero-cost profit symmetry");
    const auto cost = option_profit_probability(100.0, 0.0, 0.0001,
        0.5, 0.0, -0.2, 0.0, 0.0, 0.1, 0.01);
    require(cost.probability_profit < 0.3, "theta/spread/fees lower profit odds");
    const auto convex = option_profit_probability(100.0, 0.0, 0.0001,
        0.0, 0.1, -0.05, 0.0, 0.0, 0.0, 0.0);
    require(std::abs(convex.probability_profit - 0.31731050786291415) < 1e-12,
        "quadratic profit tail probability");
    const auto deterministic = option_profit_probability(100.0, 0.01, 0.0,
        0.5, 0.0, -0.5, 0.0, 0.0, 0.0, 0.0);
    require(deterministic.probability_profit == 0.0, "zero net pnl is not a profit");
    require_throws([&] { predict(state, {}, options, 0.5, 30.0); }, "wrong dimensions must fail");
    require_throws([&] { predict(state, stock, std::vector<double>(10, missing), 0.5, 30.0); },
        "the old v2 option/context vector must be rejected");
    require_throws([&] { predict(state, stock, options, 1.5, 30.0); }, "quality outside bounds must fail");
    require_throws([&] { learn(State{}, fitted, 0.1); }, "future trained receipt must fail");
    const auto rebuilt = learn_replay(State{}, fitted, -0.01, 30.0);
    require(rebuilt.samples == 1.0, "replay must rebuild a lower-sample checkpoint");
    for (std::size_t index = 0; index < EXPERT_COUNT; ++index) {
        require(std::abs(rebuilt.brier_sum[index] - fitted.probabilities[index] * fitted.probabilities[index]) < 1e-12,
            "replay Brier score must retain original issue-time probabilities");
    }
    require_throws([&] { learn(state, first, missing); }, "missing outcome must fail");
    require_throws([&] { auto data = state.pack(); data[0] = -1.0; State::unpack(data); }, "corrupt state must fail");
    require_throws([&] { auto data = first.pack(); data[FEATURE_COUNT] = 0.3; Prediction::unpack(data); },
        "nonbinary missing mask must fail");
    require_throws([&] { option_profit_probability(100.0, 0.0, -1.0, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0); },
        "negative return variance must fail");
    std::cout << "C++ online forecast tests passed; 3000 predict/learn pairs " << elapsed
        << " ms; state=" << State::SIZE * sizeof(double) << " bytes\n";
}
