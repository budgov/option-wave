cmake_minimum_required(VERSION 3.20)
project(OceanWaveKernelTests VERSION 1.2.0 LANGUAGES CXX)
include(CTest)

# Retain Release assertions without MSVC's duplicate-definition warning.
if(MSVC)
  foreach(configuration IN ITEMS RELEASE RELWITHDEBINFO MINSIZEREL)
    string(REPLACE "/DNDEBUG" "" CMAKE_CXX_FLAGS_${configuration} "${CMAKE_CXX_FLAGS_${configuration}}")
  endforeach()
endif()

if(BUILD_TESTING)
  foreach(kernel IN ITEMS cpp_kernel_smoke cpp_fourier_features_test cpp_pde_stability_test cpp_online_forecast_test)
    add_executable(${kernel} tests/${kernel}.cpp)
    target_compile_features(${kernel} PRIVATE cxx_std_17)
    target_include_directories(${kernel} PRIVATE cpp)
    if(MSVC)
      # Release builds must retain test assertions. Never compile checks away.
      target_compile_options(${kernel} PRIVATE /O2 /W4 /WX /permissive- /sdl /guard:cf /UNDEBUG)
      target_link_options(${kernel} PRIVATE /DYNAMICBASE /NXCOMPAT /guard:cf)
    else()
      target_compile_options(${kernel} PRIVATE -O2 -Wall -Wextra -Wpedantic -Werror -fstack-protector-strong -UNDEBUG)
      if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
        target_link_options(${kernel} PRIVATE -Wl,-z,relro -Wl,-z,now)
      endif()
    endif()
    add_test(NAME ${kernel} COMMAND ${kernel})
    set_tests_properties(${kernel} PROPERTIES TIMEOUT 30)
  endforeach()
  find_package(Python 3.10 COMPONENTS Interpreter REQUIRED)
  add_test(NAME python_suite COMMAND ${Python_EXECUTABLE} -B -m unittest discover -s tests -v)
  set_tests_properties(python_suite PROPERTIES
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
    ENVIRONMENT "PDE_TEST_BINARY=$<TARGET_FILE:cpp_pde_stability_test>;PYTHONDONTWRITEBYTECODE=1"
    TIMEOUT 120)
endif()
