import os
import sys

from setuptools import find_packages, setup
from pybind11.setup_helpers import Pybind11Extension, build_ext


compile_args = ["/O2"] if sys.platform == "win32" else ["-O3", "-DNDEBUG"]
if os.getenv("OCEAN_WAVE_NATIVE") == "1" and sys.platform not in {"darwin", "win32"}:
    compile_args.append("-march=native")


setup(
    name="ocean-wave",
    version="1.0.0",
    packages=find_packages(),
    ext_modules=[
        Pybind11Extension(
            "option_wave._core",
            ["cpp/option_wave_core.cpp"],
            cxx_std=17,
            extra_compile_args=compile_args,
        )
    ],
    cmdclass={"build_ext": build_ext},
)
