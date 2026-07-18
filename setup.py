from setuptools import find_packages, setup
from pybind11.setup_helpers import Pybind11Extension, build_ext


setup(
    name="option-wave",
    version="0.9.0",
    packages=find_packages(),
    ext_modules=[
        Pybind11Extension(
            "option_wave._core",
            ["cpp/option_wave_core.cpp"],
            cxx_std=17,
            extra_compile_args=["-O3"],
        )
    ],
    cmdclass={"build_ext": build_ext},
)
