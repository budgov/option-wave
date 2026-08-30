#include "../cpp/ocean_wave_kernels.hpp"

#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <vector>

namespace {

void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

void require_close(double actual, double expected, double tolerance, const char* message) {
    if (!std::isfinite(actual) || std::abs(actual - expected) > tolerance) {
        throw std::runtime_error(message);
    }
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

}  // namespace

int main() {
    constexpr std::size_t sample_count = 64;
    constexpr double primary_amplitude = 0.020;
    constexpr double primary_phase = 0.30;
    constexpr double secondary_amplitude = 0.010;
    constexpr double secondary_phase = -0.70;
    std::vector<double> buffer(128, std::numeric_limits<double>::quiet_NaN());
    for (std::size_t index = 0; index < sample_count; ++index) {
        const double primary_angle = ocean_wave::TWO_PI * 4.0 * static_cast<double>(index)
            / static_cast<double>(sample_count) + primary_phase;
        const double secondary_angle = ocean_wave::TWO_PI * 7.0 * static_cast<double>(index)
            / static_cast<double>(sample_count) + secondary_phase;
        buffer[index] = 0.001 + primary_amplitude * std::cos(primary_angle)
            + secondary_amplitude * std::cos(secondary_angle);
    }

    const auto features = ocean_wave::extract_intraday_fourier(buffer, sample_count, 8, 1.0, false, false);
    require(features.sample_count == sample_count, "causal sample count");
    require(features.harmonic_count == 8, "retained harmonic count");
    require_close(features.mean, 0.001, 1e-14, "demeaned mean");
    require_close(features.cosine_coefficients[3], primary_amplitude * std::cos(primary_phase), 1e-13, "cosine coefficient");
    require_close(features.sine_coefficients[3], -primary_amplitude * std::sin(primary_phase), 1e-13, "sine coefficient");
    require_close(features.amplitudes[3], primary_amplitude, 1e-13, "primary amplitude");
    require_close(features.phases[3], primary_phase, 1e-13, "primary phase");
    require_close(features.variance, 0.5 * (primary_amplitude * primary_amplitude
        + secondary_amplitude * secondary_amplitude), 1e-14, "return variance");
    require_close(features.explained_energy_fraction, 1.0, 1e-12, "retained energy fraction");
    require(features.dominant_harmonic == 4, "dominant harmonic");
    require_close(features.dominant_period, 16.0, 1e-12, "dominant period");
    require(features.spectral_entropy > 0.0 && features.spectral_entropy < 1.0, "bounded spectral entropy");
    require(!features.linear_detrend && !features.hann_taper, "disabled preprocessing metadata");

    std::vector<double> alternate_tail = buffer;
    for (std::size_t index = sample_count; index < alternate_tail.size(); ++index) {
        alternate_tail[index] = 1000.0 * static_cast<double>(index);
    }
    const auto default_reference = ocean_wave::extract_intraday_fourier(buffer, sample_count, 8, 1.0);
    const auto causal = ocean_wave::extract_intraday_fourier(alternate_tail, sample_count, 8, 1.0);
    require(causal.cosine_coefficients == default_reference.cosine_coefficients, "future tail changed cosine features");
    require(causal.sine_coefficients == default_reference.sine_coefficients, "future tail changed sine features");

    constexpr std::size_t band_sample_count = 240;
    std::vector<double> band_signal(band_sample_count);
    for (std::size_t index = 0; index < band_sample_count; ++index) {
        const double time = static_cast<double>(index);
        band_signal[index] = 0.010 * std::cos(ocean_wave::TWO_PI * time / 4.0 + 0.2)
            + 0.008 * std::cos(ocean_wave::TWO_PI * time / 10.0 - 0.4)
            + 0.006 * std::cos(ocean_wave::TWO_PI * time / 30.0 + 0.6)
            + 0.004 * std::cos(ocean_wave::TWO_PI * time / 120.0 - 0.8);
    }
    const auto band_features = ocean_wave::extract_intraday_fourier(
        band_signal, band_sample_count, 80, 1.0
    );
    require(band_features.linear_detrend && band_features.hann_taper, "default preprocessing metadata");
    require(band_features.taper_coherent_gain > 0.0 && band_features.taper_coherent_gain < 1.0, "Hann coherent gain");
    require(band_features.taper_power_gain > 0.0 && band_features.taper_power_gain < 1.0, "Hann power gain");
    for (const double energy : band_features.band_energy) require(energy > 0.0, "fixed minute band energy");
    require_close(
        band_features.dominant_phase_sine * band_features.dominant_phase_sine
            + band_features.dominant_phase_cosine * band_features.dominant_phase_cosine,
        1.0,
        1e-12,
        "dominant phase unit circle"
    );

    const std::vector<double> constant(sample_count, 0.0025);
    const auto flat = ocean_wave::extract_intraday_fourier(constant, sample_count, 8, 1.0);
    require(flat.dominant_harmonic == 0, "constant series dominant harmonic");
    require(flat.dominant_period == 0.0, "constant series dominant period");
    require(flat.spectral_entropy == 0.0, "constant series entropy");

    require_throws([] {
        ocean_wave::extract_intraday_fourier(std::vector<double>(7, 0.0), 7, 4, 1.0);
    }, "short input must be rejected");
    require_throws([] {
        ocean_wave::extract_intraday_fourier(std::vector<double>(16, 0.0), 17, 4, 1.0);
    }, "invalid causal prefix must be rejected");
    require_throws([] {
        ocean_wave::extract_intraday_fourier(std::vector<double>(16, 0.0), 16, 257, 1.0);
    }, "unbounded harmonics must be rejected");
    require_throws([] {
        auto values = std::vector<double>(16, 0.0);
        values[4] = std::numeric_limits<double>::infinity();
        ocean_wave::extract_intraday_fourier(values, 16, 4, 1.0);
    }, "non-finite causal return must be rejected");
    require_throws([] {
        auto values = std::vector<double>(16, 0.0);
        values[4] = 11.0;
        ocean_wave::extract_intraday_fourier(values, 16, 4, 1.0);
    }, "out-of-range causal return must be rejected");
    require_throws([] {
        ocean_wave::extract_intraday_fourier(std::vector<double>(16, 0.0), 16, 4, 1e-10);
    }, "unsafe sample interval must be rejected");
    require_throws([] {
        ocean_wave::extract_intraday_fourier(std::vector<double>(4097, 0.0), 4097, 4, 1.0);
    }, "unbounded sample count must be rejected");

    std::cout << "C++ intraday Fourier feature test passed\n";
    return 0;
}
