import os
import sys

from setuptools import setup
from pybind11.setup_helpers import Pybind11Extension, build_ext


if sys.platform == "win32":
    compile_args = ["/O2", "/W4", "/permissive-", "/sdl", "/utf-8", "/EHsc", "/DNDEBUG", "/guard:cf"]
    link_args = ["/DYNAMICBASE", "/NXCOMPAT", "/guard:cf"]
else:
    compile_args = ["-O3", "-DNDEBUG", "-Wall", "-Wextra", "-Wpedantic", "-fstack-protector-strong"]
    link_args = ["-Wl,-z,relro", "-Wl,-z,now"] if sys.platform.startswith("linux") else []
if os.getenv("OCEAN_WAVE_NATIVE") == "1" and sys.platform not in {"darwin", "win32"}:
    compile_args.append("-march=native")


setup(
    name="ocean-wave",
    version="1.2.0",
    packages=["option_wave"],
    ext_modules=[
        Pybind11Extension(
            "option_wave._core",
            ["cpp/option_wave_core.cpp"],
            cxx_std=17,
            extra_compile_args=compile_args,
            extra_link_args=link_args,
        )
    ],
    cmdclass={"build_ext": build_ext},
)
