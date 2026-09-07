#include "ocean_wave_kernels.hpp"

#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <vector>

void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

template <typename Callable>
void require_throws(Callable&& callable, const char* message) {
    try {
        callable();
    } catch (const std::runtime_error&) {
        return;
    }
    throw std::runtime_error(message);
}

int main() {
    const auto aggregate = ocean_wave::aggregate_surface(
        {0.60, 0.40},
        {0.80, 0.80},
        {0.25, -0.25},
        {1.00, 1.00}
    );
    require(aggregate.pair_signal.size() == 2, "surface size");
    require(std::abs(aggregate.premium_signal) < 1e-12, "premium signal");
    require(std::abs(aggregate.mean_pair_confidence - 0.80) < 1e-12, "pair confidence");

    const auto stock = ocean_wave::stock_confirmation(
        101.0, 100.0, 100.5, 0.003, 0.006, 1.2, 0.20, 1.0
    );
    require(stock.signal > 0.0, "stock signal");
    const double expected_volume_quality = 0.75 + 0.25 * std::tanh(std::log(1.2));
    require(std::abs(stock.confidence - expected_volume_quality) < 1e-12, "stock volume reliability gate");
    const double missing = std::numeric_limits<double>::quiet_NaN();
    for (double relative_volume : {0.2, 1.0, 2.0, 10.0}) {
        const auto volume_only = ocean_wave::stock_confirmation(
            100.0, missing, missing, missing, missing, relative_volume, 0.2, 1.0);
        require(volume_only.signal == 0.0 && volume_only.confidence == 0.0,
            "unsigned RVOL alone cannot predict direction");
        const auto up = ocean_wave::stock_confirmation(
            100.0, missing, missing, 0.003, 0.006, relative_volume, 0.2, 1.0);
        const auto down = ocean_wave::stock_confirmation(
            100.0, missing, missing, -0.003, -0.006, relative_volume, 0.2, 1.0);
        require(std::abs(up.signal + down.signal) < 1e-12, "RVOL must preserve price-sign symmetry");
        require(up.confidence == down.confidence, "RVOL confidence cannot prefer bullish prices");
    }

    const auto forecast = ocean_wave::forecast_surface(
        {0.0, 0.0, 1.0, 1.0},
        {0.0, 0.05, 0.0, 0.05},
        {0.10, 0.20, 0.05, 0.15},
        {1.00, 0.80, 0.90, 0.70},
        {0.01, 0.02, 0.01, 0.02},
        0.15,
        0.80,
        0.02,
        100.0,
        0.25,
        0.90,
        0.01,
        1.0,
        1.0,
        252.0 * 390.0,
        0.015,
        0.010,
        0.0,
        0.020,
        0.080,
        1.0,
        {5.0, 30.0}
    );
    require(forecast.field.size() == 4, "field size");
    require(forecast.expected_prices.size() == 2, "expectation count");
    require(std::isfinite(forecast.expected_prices.back()), "finite expected price");
    require(forecast.probabilities_up.back() >= 0.0, "probability lower bound");
    require(forecast.probabilities_up.back() <= 1.0, "probability upper bound");
    require_throws([] {
        ocean_wave::aggregate_surface({0.5}, {0.8, 0.7}, {0.0}, {1.0});
    }, "mismatched vectors must be rejected");
    require_throws([] {
        ocean_wave::evolve({0.0}, {1.0}, {0.0}, {0.0}, 0.01, 0.01, 0.0, 0.01, 0.1, 1.0, {});
    }, "empty horizons must be rejected");
    std::cout << "C++ kernel smoke test passed\n";
    return 0;
}
