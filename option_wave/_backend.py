"""Optional compiled backend selector.

The source tree remains importable before an editable install. Once
``pip install -e .`` has built the extension, the numerical hot paths use C++.
"""

try:  # pragma: no cover - the branch depends on the local build environment.
    from . import _core as cpp_core
except ImportError:  # pragma: no cover
    cpp_core = None

HAS_CPP_CORE = cpp_core is not None
