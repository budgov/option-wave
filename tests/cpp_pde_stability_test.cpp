#include "ocean_wave_kernels.hpp"

#include <chrono>
#include <iomanip>
#include <iostream>
#include <string>

namespace {
void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

template <typename Callable>
void rejects(Callable&& callable) {
    try { callable(); } catch (const std::runtime_error&) { return; }
    throw std::runtime_error("invalid PDE input was accepted");
}

double maximum_absolute(const std::vector<double>& values) {
    double value = 0.0;
    for (const double item : values) value = std::max(value, std::abs(item));
    return value;
}

ocean_wave::Evolution fixture() {
    return ocean_wave::evolve(
        {0.1, -0.5, 0.8, 0.2, 0.9, -0.7, -0.2, 0.4, -0.6, 0.3, -0.1, 0.7},
        {1, 2, 3, 4, 2, 0, 1, 5, 4, 2, 1, 3},
        {0.0, 0.002, 0.03, 0.09}, {0.0, 1.0, 7.0},
        0.015, 0.010, -0.007, 0.020, 0.080, 0.7, {2.25, 0.25, 1.4, 2.25}, true
    );
}

void emit_array(const char* name, const std::vector<double>& values, bool comma) {
    std::cout << (comma ? ",\"" : "\"") << name << "\":[";
    for (std::size_t i = 0; i < values.size(); ++i) std::cout << (i ? "," : "") << values[i];
    std::cout << "]";
}

double diffusion_error(int count, double dt, double horizon) {
    std::vector<double> x(count), observed(count), weights(count, 1.0);
    for (int i = 0; i < count; ++i) {
        x[i] = static_cast<double>(i) / (count - 1);
        observed[i] = std::cos(0.5 * ocean_wave::TWO_PI * x[i]);
    }
    const auto result = ocean_wave::evolve(observed, weights, x, {0.0}, 0.1, 0.0, 0.0, 0.0, 0.0, dt, {horizon});
    const double amplitude = std::exp(-0.1 * std::pow(0.5 * ocean_wave::TWO_PI, 2) * horizon);
    double error = 0.0;
    for (int i = 0; i < count; ++i) error = std::max(error, std::abs(result.field[i] - amplitude * observed[i]));
    return error;
}
}  // namespace

int main(int argc, char** argv) {
    std::cout << std::setprecision(17);
    if (argc == 2 && std::string(argv[1]) == "--fixture") {
        const auto result = fixture();
        std::cout << "{";
        emit_array("field", result.field, false);
        emit_array("scores", result.scores, true);
        emit_array("integrals", result.integrals, true);
        emit_array("averages", result.averages, true);
        std::cout << "}\n";
        return 0;
    }
    const auto started = std::chrono::steady_clock::now();
    const std::vector<double> x{0.0, 0.002, 0.011, 0.05, 0.12};
    const auto constant = ocean_wave::evolve(std::vector<double>(15, 0.4), std::vector<double>(15, 1.0),
        x, {0, 1, 3}, 0.015, 0.01, 0.004, 0.0, 0.08, 1.0, {0.25, 1.5, 10.25}, true);
    for (const double value : constant.field) require(std::abs(value - 0.4) < 2e-12, "constant solution changed");
    require(std::abs(constant.integrals[0] - 0.1) < 1e-12, "fractional horizon integral overshot");
    require(std::abs(constant.integrals.back() - 4.1) < 2e-11, "final horizon integral overshot");
    require(constant.scores.size() == 12, "final partial step missing");

    const auto boundary = ocean_wave::evolve({1, 0, 0}, {0.25, 0.5, 0.25}, {0, 0.5, 1}, {0},
        1.0, 0.0, 0.0, 0.0, 0.0, 0.25, {0.25});
    require(std::abs(boundary.field[0] - 7.0 / 15.0) < 1e-14, "left Neumann finite-volume boundary");
    require(std::abs(boundary.field[1] - 0.2) < 1e-14, "interior diffusion stencil");
    require(std::abs(boundary.field[2] - 2.0 / 15.0) < 1e-14, "right Neumann finite-volume boundary");

    std::vector<double> weights(x.size()), pulse{1, 0, -0.4, 0.2, -0.3};
    for (std::size_t i = 0; i < x.size(); ++i) weights[i] = 0.5 * (
        (i > 0 ? x[i] - x[i - 1] : 0.0) + (i + 1 < x.size() ? x[i + 1] - x[i] : 0.0));
    const double initial_mass = ocean_wave::weighted_mean(pulse, weights);
    const auto irregular = ocean_wave::evolve(pulse, weights, x, {0}, 0.015, 0, 0, 0, 0, 1, {5});
    require(std::abs(ocean_wave::weighted_mean(irregular.field, weights) - initial_mass) < 2e-13,
        "nonuniform Neumann diffusion does not conserve cell-weighted score");

    std::vector<double> fine_x(257), oscillation(257);
    for (std::size_t i = 0; i < fine_x.size(); ++i) {
        fine_x[i] = i * 0.0001;
        oscillation[i] = i % 2 ? -0.6 : 0.6;
    }
    const auto high_frequency = ocean_wave::evolve(oscillation, std::vector<double>(257, 1), fine_x, {0},
        0.015, 0, 0, 0, 0, 1, {1});
    require(maximum_absolute(high_frequency.field) < 2e-7, "stiff high-frequency mode not damped");

    auto scaled_x = x;
    for (double& coordinate : scaled_x) coordinate *= 100.0;
    const auto unscaled = ocean_wave::evolve(pulse, weights, x, {0}, 0.015, 0, 0.004, 0.02, 0.08, 0.5, {3});
    const auto scaled = ocean_wave::evolve(pulse, weights, scaled_x, {0}, 150.0, 0, 0.4, 0.02, 0.08, 0.5, {3});
    for (std::size_t i = 0; i < x.size(); ++i) require(std::abs(unscaled.field[i] - scaled.field[i]) < 1e-12,
        "coordinate/coefficient rescaling changes the solution");
    const auto positive = ocean_wave::evolve({0, 1, 0}, {1, 1, 1}, {0, 0.01, 1}, {0},
        0.015, 0, -20, 0.02, 0.08, 100, {100});
    for (double value : positive.field) require(value >= 0 && value <= 1, "implicit maximum principle violated");
    const auto extreme_weights = ocean_wave::evolve({0.2, 0.8}, {1e308, 1e308}, {0, 1}, {0},
        0, 0, 0, 0, 0, 1, {1});
    require(std::abs(extreme_weights.averages[0] - 0.5) < 1e-14, "finite large weights overflowed aggregation");

    const double time_coarse = diffusion_error(101, 0.2, 1.0);
    const double time_medium = diffusion_error(101, 0.1, 1.0);
    const double time_fine = diffusion_error(101, 0.05, 1.0);
    require(time_coarse / time_medium > 1.8 && time_medium / time_fine > 1.8, "first-order time convergence missing");
    const double grid_coarse = diffusion_error(11, 0.0001, 0.1);
    const double grid_medium = diffusion_error(21, 0.0001, 0.1);
    const double grid_fine = diffusion_error(41, 0.0001, 0.1);
    require(grid_coarse / grid_medium > 3.0 && grid_medium / grid_fine > 3.0, "spatial convergence missing");

    for (double invalid : {-1.0, 0.0, std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN()}) {
        rejects([&] { ocean_wave::evolve({0}, {1}, {0}, {0}, 0, 0, 0, 0, 0, invalid, {1}); });
    }
    rejects([] { ocean_wave::evolve({0, 1}, {1, 1}, {0, 0}, {0}, 0, 0, 0, 0, 0, 1, {1}); });
    rejects([] { ocean_wave::evolve({0, 1}, {1, 1}, {1, 0}, {0}, 0, 0, 0, 0, 0, 1, {1}); });
    rejects([] { ocean_wave::evolve({0}, {-1}, {0}, {0}, 0, 0, 0, 0, 0, 1, {1}); });
    rejects([] { ocean_wave::evolve({0}, {1}, {0}, {0}, -0.1, 0, 0, 0, 0, 1, {1}); });
    rejects([] { ocean_wave::evolve({0}, {1}, {0}, {0}, 0, 0, 0, -0.1, 0, 1, {1}); });
    rejects([] { ocean_wave::evolve({0}, {1}, {0}, {0}, 0, 0, 0, 0, -0.1, 1, {1}); });
    rejects([] { ocean_wave::evolve({0}, {1}, {0}, {0}, 0, 0, 0, 0, 0, 1e-9, {1}); });
    rejects([] { ocean_wave::evolve({0}, {1}, {0}, {0}, 0, 0, 0, 0, 0, 1, {}); });
    rejects([] { ocean_wave::evolve({0}, {1}, {0}, {0}, 0, 0, 0, 0, 0, 1, std::vector<double>(10001, 1)); });
    rejects([] { ocean_wave::evolve({2}, {1}, {0}, {0}, 0, 0, 0, 0, 0, 1, {1}); });
    rejects([] {
        std::vector<double> coordinates(101);
        for (std::size_t i = 0; i < coordinates.size(); ++i) coordinates[i] = static_cast<double>(i);
        ocean_wave::evolve(std::vector<double>(101), std::vector<double>(101, 1), coordinates, {0},
            0, 0, 0, 0, 0, 1, {1'000'000});
    });

    std::cout << "PDE tests passed; time errors " << time_coarse << ", " << time_medium << ", " << time_fine
        << "; grid errors " << grid_coarse << ", " << grid_medium << ", " << grid_fine
        << "; high-frequency peak " << maximum_absolute(high_frequency.field)
        << "; elapsed_ms " << std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count()
        << '\n';
}
