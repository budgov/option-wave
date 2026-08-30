#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>

#include <algorithm>
#include <atomic>
#include <climits>
#include <cctype>
#include <cstdio>
#include <cstdint>
#include <cwctype>
#include <filesystem>
#include <iomanip>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

namespace fs = std::filesystem;

namespace {

constexpr wchar_t kWindowClass[] = L"OceanWaveSupervisorHostWindowV1";
constexpr std::uintmax_t kMaximumLogBytes = 10U * 1024U * 1024U;
constexpr DWORD kGracefulStopTimeoutSeconds = 120U;

class unique_handle final {
 public:
  unique_handle() noexcept = default;
  explicit unique_handle(HANDLE value) noexcept : value_(value) {}
  ~unique_handle() { reset(); }

  unique_handle(const unique_handle&) = delete;
  unique_handle& operator=(const unique_handle&) = delete;

  unique_handle(unique_handle&& other) noexcept : value_(other.release()) {}
  unique_handle& operator=(unique_handle&& other) noexcept {
    if (this != &other) reset(other.release());
    return *this;
  }

  [[nodiscard]] HANDLE get() const noexcept { return value_; }
  [[nodiscard]] explicit operator bool() const noexcept {
    return value_ != nullptr && value_ != INVALID_HANDLE_VALUE;
  }
  [[nodiscard]] HANDLE release() noexcept {
    const HANDLE released = value_;
    value_ = nullptr;
    return released;
  }
  void reset(HANDLE next = nullptr) noexcept {
    if (value_ != nullptr && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_);
    value_ = next;
  }

 private:
  HANDLE value_ = nullptr;
};

struct Options final {
  std::optional<fs::path> project_root;
  std::optional<fs::path> config;
  bool self_test = false;
};

struct RuntimePaths final {
  fs::path root;
  fs::path config;
  fs::path script;
  fs::path node;
  fs::path log;
};

struct ChildProcess final {
  unique_handle process;
  unique_handle thread;
  DWORD process_id = 0;
};

[[nodiscard]] std::wstring Win32Message(DWORD code) {
  wchar_t* raw = nullptr;
  const DWORD length = FormatMessageW(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
          FORMAT_MESSAGE_IGNORE_INSERTS,
      nullptr, code, 0, reinterpret_cast<wchar_t*>(&raw), 0, nullptr);
  std::wstring message = length != 0 && raw != nullptr
                             ? std::wstring(raw, static_cast<std::size_t>(length))
                             : L"Win32 error " + std::to_wstring(code);
  if (raw != nullptr) LocalFree(raw);
  while (!message.empty() &&
         (message.back() == L'\r' || message.back() == L'\n' ||
          message.back() == L' ' || message.back() == L'.')) {
    message.pop_back();
  }
  return message;
}

[[nodiscard]] std::string Utf8(std::wstring_view value) {
  if (value.empty()) return {};
  const int required = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
                                           value.data(),
                                           static_cast<int>(value.size()),
                                           nullptr, 0, nullptr, nullptr);
  if (required <= 0) return "Unicode conversion failed";
  std::string result(static_cast<std::size_t>(required), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), result.data(),
                          required, nullptr, nullptr) <= 0) {
    return "Unicode conversion failed";
  }
  return result;
}

[[nodiscard]] std::wstring Wide(std::string_view value) {
  if (value.empty()) return {};
  const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                           value.data(),
                                           static_cast<int>(value.size()),
                                           nullptr, 0);
  if (required <= 0) return L"Unknown error";
  std::wstring result(static_cast<std::size_t>(required), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), result.data(),
                          required) <= 0) {
    return L"Unknown error";
  }
  return result;
}

[[noreturn]] void ThrowWin32(std::wstring_view operation) {
  const DWORD code = GetLastError();
  throw std::runtime_error(Utf8(std::wstring(operation) + L": " +
                                Win32Message(code)));
}

[[nodiscard]] std::wstring Timestamp() {
  SYSTEMTIME now{};
  GetLocalTime(&now);
  wchar_t buffer[64]{};
  swprintf_s(buffer, L"%04u-%02u-%02uT%02u:%02u:%02u.%03u",
             static_cast<unsigned>(now.wYear),
             static_cast<unsigned>(now.wMonth),
             static_cast<unsigned>(now.wDay),
             static_cast<unsigned>(now.wHour),
             static_cast<unsigned>(now.wMinute),
             static_cast<unsigned>(now.wSecond),
             static_cast<unsigned>(now.wMilliseconds));
  return buffer;
}

void AppendLog(const fs::path& filename, std::wstring_view level,
               std::wstring_view message) noexcept {
  if (filename.empty()) return;
  try {
    std::wstring clean(message);
    std::replace(clean.begin(), clean.end(), L'\r', L' ');
    std::replace(clean.begin(), clean.end(), L'\n', L' ');
    const std::string line = Utf8(Timestamp() + L" [native-host] [" +
                                  std::wstring(level) + L"] " + clean + L"\r\n");
    unique_handle file(CreateFileW(
        filename.c_str(), FILE_APPEND_DATA,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
        OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!file) return;
    DWORD written = 0;
    WriteFile(file.get(), line.data(), static_cast<DWORD>(line.size()),
              &written, nullptr);
  } catch (...) {
    // Logging is best-effort and must never disrupt graceful shutdown.
  }
}

[[nodiscard]] bool EqualOrdinalIgnoreCase(std::wstring_view left,
                                          std::wstring_view right) {
  if (left.size() > static_cast<std::size_t>(INT_MAX) ||
      right.size() > static_cast<std::size_t>(INT_MAX)) {
    return false;
  }
  return CompareStringOrdinal(left.data(), static_cast<int>(left.size()),
                              right.data(), static_cast<int>(right.size()),
                              TRUE) == CSTR_EQUAL;
}

[[nodiscard]] bool SamePath(const fs::path& left, const fs::path& right) {
  return EqualOrdinalIgnoreCase(left.native(), right.native());
}

[[nodiscard]] bool IsWithin(const fs::path& candidate, const fs::path& root) {
  auto candidate_part = candidate.begin();
  for (auto root_part = root.begin(); root_part != root.end();
       ++root_part, ++candidate_part) {
    if (candidate_part == candidate.end() ||
        !EqualOrdinalIgnoreCase(root_part->native(), candidate_part->native())) {
      return false;
    }
  }
  return true;
}

[[nodiscard]] fs::path CanonicalDirectory(const fs::path& value,
                                           std::wstring_view label) {
  std::error_code error;
  const fs::path result = fs::canonical(value, error);
  if (error || !fs::is_directory(result, error) || error) {
    throw std::runtime_error(Utf8(std::wstring(label) +
                                  L" is not an accessible directory: " +
                                  value.native()));
  }
  return result;
}

[[nodiscard]] fs::path CanonicalFile(const fs::path& value,
                                     std::wstring_view label) {
  std::error_code error;
  const fs::path result = fs::canonical(value, error);
  if (error || !fs::is_regular_file(result, error) || error) {
    throw std::runtime_error(Utf8(std::wstring(label) +
                                  L" is not an accessible regular file: " +
                                  value.native()));
  }
  return result;
}

[[nodiscard]] fs::path ModulePath() {
  std::vector<wchar_t> buffer(1024U);
  for (;;) {
    const DWORD length = GetModuleFileNameW(
        nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (length == 0) ThrowWin32(L"GetModuleFileNameW");
    if (length < buffer.size() - 1U) {
      return fs::path(std::wstring(buffer.data(), length));
    }
    if (buffer.size() >= 32768U) {
      throw std::runtime_error("Executable path exceeds the Windows limit.");
    }
    buffer.resize(buffer.size() * 2U);
  }
}

[[nodiscard]] std::optional<std::wstring> EnvironmentValue(
    const wchar_t* name) {
  const DWORD required = GetEnvironmentVariableW(name, nullptr, 0);
  if (required == 0) return std::nullopt;
  std::vector<wchar_t> buffer(static_cast<std::size_t>(required));
  const DWORD length = GetEnvironmentVariableW(
      name, buffer.data(), static_cast<DWORD>(buffer.size()));
  if (length == 0 || length >= buffer.size()) return std::nullopt;
  return std::wstring(buffer.data(), length);
}

[[nodiscard]] fs::path LocateNode() {
  std::vector<fs::path> candidates;
  if (const auto configured = EnvironmentValue(L"OCEAN_WAVE_NODE_EXE")) {
    candidates.emplace_back(*configured);
  }
  for (const wchar_t* variable : {L"ProgramW6432", L"ProgramFiles"}) {
    if (const auto base = EnvironmentValue(variable)) {
      candidates.emplace_back(fs::path(*base) / L"nodejs" / L"node.exe");
    }
  }

  std::vector<wchar_t> search(32768U);
  const DWORD length = SearchPathW(nullptr, L"node.exe", nullptr,
                                   static_cast<DWORD>(search.size()),
                                   search.data(), nullptr);
  if (length > 0 && length < search.size()) {
    candidates.emplace_back(std::wstring(search.data(), length));
  }

  for (const fs::path& candidate : candidates) {
    std::error_code error;
    const fs::path canonical = fs::canonical(candidate, error);
    if (error || !fs::is_regular_file(canonical, error) || error) continue;
    if (!EqualOrdinalIgnoreCase(canonical.filename().native(), L"node.exe")) {
      continue;
    }
    return canonical;
  }
  throw std::runtime_error(
      "node.exe was not found. Install the supported Node.js runtime or set "
      "OCEAN_WAVE_NODE_EXE to its absolute path.");
}

[[nodiscard]] Options ParseOptions() {
  int count = 0;
  wchar_t** raw = CommandLineToArgvW(GetCommandLineW(), &count);
  if (raw == nullptr) ThrowWin32(L"CommandLineToArgvW");
  struct LocalFreeGuard final {
    wchar_t** value;
    ~LocalFreeGuard() { LocalFree(value); }
  } guard{raw};

  Options options;
  for (int index = 1; index < count; ++index) {
    const std::wstring argument(raw[index]);
    auto take_value = [&](std::optional<fs::path>& target,
                          std::wstring_view name) {
      if (target.has_value()) {
        throw std::runtime_error(Utf8(std::wstring(name) +
                                      L" may only be specified once."));
      }
      if (index + 1 >= count || raw[index + 1][0] == L'\0') {
        throw std::runtime_error(
            Utf8(std::wstring(name) + L" requires a value."));
      }
      target = fs::path(raw[++index]);
    };

    if (argument == L"--project-root") {
      take_value(options.project_root, L"--project-root");
    } else if (argument == L"--config") {
      take_value(options.config, L"--config");
    } else if (argument == L"--self-test") {
      if (options.self_test) {
        throw std::runtime_error("--self-test may only be specified once.");
      }
      options.self_test = true;
    } else {
      throw std::runtime_error(Utf8(L"Unsupported argument: " + argument));
    }
  }
  return options;
}

void RotateLog(const fs::path& filename) noexcept {
  try {
    std::error_code error;
    if (!fs::exists(filename, error) || error ||
        fs::file_size(filename, error) < kMaximumLogBytes || error) {
      return;
    }
    const fs::path previous = filename.native() + std::wstring(L".1");
    fs::remove(previous, error);
    error.clear();
    fs::rename(filename, previous, error);
  } catch (...) {
    // A busy log can safely continue growing until the next launch.
  }
}

[[nodiscard]] RuntimePaths ResolvePaths(const Options& options) {
  const fs::path default_root = ModulePath().parent_path().parent_path();
  const fs::path requested_root = options.project_root.value_or(default_root);
  if (!requested_root.is_absolute()) {
    throw std::runtime_error("--project-root must be an absolute path.");
  }
  const fs::path root = CanonicalDirectory(requested_root, L"Project root");
  const fs::path requested_config = options.config.has_value()
                                        ? (options.config->is_absolute()
                                               ? *options.config
                                               : root / *options.config)
                                        : root / L"config.json";
  const fs::path config = CanonicalFile(requested_config, L"Configuration");
  if (!SamePath(config.parent_path(), root)) {
    throw std::runtime_error(
        "--config must name a regular file directly inside --project-root.");
  }

  const fs::path script = CanonicalFile(
      root / L"scripts" / L"ocean-wave-supervisor.js",
      L"Supervisor entrypoint");
  if (!IsWithin(script, root)) {
    throw std::runtime_error(
        "Supervisor entrypoint resolves outside the project root.");
  }
  (void)CanonicalFile(root / L"package.json", L"Project package manifest");

  const fs::path requested_log_directory = root / L"logs";
  std::error_code error;
  fs::create_directories(requested_log_directory, error);
  if (error) {
    throw std::runtime_error("Could not create the project log directory: " +
                             error.message());
  }
  const fs::path log_directory = CanonicalDirectory(
      requested_log_directory, L"Project log directory");
  if (!IsWithin(log_directory, root)) {
    throw std::runtime_error("Project log directory resolves outside the root.");
  }
  const fs::path log = log_directory / L"supervisor-native.log";
  RotateLog(log);

  return RuntimePaths{root, config, script, LocateNode(), log};
}

[[nodiscard]] std::wstring QuoteArgument(std::wstring_view argument) {
  if (!argument.empty() &&
      argument.find_first_of(L" \t\n\v\"") == std::wstring_view::npos) {
    return std::wstring(argument);
  }
  std::wstring quoted(1U, L'\"');
  std::size_t slashes = 0;
  for (const wchar_t character : argument) {
    if (character == L'\\') {
      ++slashes;
      continue;
    }
    if (character == L'\"') {
      quoted.append(slashes * 2U + 1U, L'\\');
      quoted.push_back(L'\"');
    } else {
      quoted.append(slashes, L'\\');
      quoted.push_back(character);
    }
    slashes = 0;
  }
  quoted.append(slashes * 2U, L'\\');
  quoted.push_back(L'\"');
  return quoted;
}

[[nodiscard]] std::wstring BuildCommandLine(
    const std::vector<std::wstring>& arguments) {
  std::wstring command_line;
  for (const std::wstring& argument : arguments) {
    if (!command_line.empty()) command_line.push_back(L' ');
    command_line += QuoteArgument(argument);
  }
  return command_line;
}

[[nodiscard]] unique_handle OpenInheritedLog(const fs::path& filename) {
  SECURITY_ATTRIBUTES attributes{};
  attributes.nLength = sizeof(attributes);
  attributes.bInheritHandle = TRUE;
  unique_handle result(CreateFileW(
      filename.c_str(), FILE_APPEND_DATA | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, &attributes,
      OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!result) ThrowWin32(L"Open supervisor log");
  return result;
}

[[nodiscard]] unique_handle OpenInheritedNullInput() {
  SECURITY_ATTRIBUTES attributes{};
  attributes.nLength = sizeof(attributes);
  attributes.bInheritHandle = TRUE;
  unique_handle result(CreateFileW(L"NUL", GENERIC_READ | SYNCHRONIZE,
                                   FILE_SHARE_READ | FILE_SHARE_WRITE,
                                   &attributes, OPEN_EXISTING,
                                   FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!result) ThrowWin32(L"Open NUL input");
  return result;
}

[[nodiscard]] ChildProcess CreateNodeProcess(
    const RuntimePaths& paths, const std::vector<std::wstring>& node_arguments,
    DWORD creation_flags) {
  std::vector<std::wstring> arguments;
  arguments.reserve(node_arguments.size() + 1U);
  arguments.push_back(paths.node.native());
  arguments.insert(arguments.end(), node_arguments.begin(),
                   node_arguments.end());
  std::wstring command_line = BuildCommandLine(arguments);
  std::vector<wchar_t> mutable_command(command_line.begin(), command_line.end());
  mutable_command.push_back(L'\0');

  unique_handle log = OpenInheritedLog(paths.log);
  unique_handle null_input = OpenInheritedNullInput();
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = null_input.get();
  startup.hStdOutput = log.get();
  startup.hStdError = log.get();
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(paths.node.c_str(), mutable_command.data(), nullptr,
                      nullptr, TRUE, creation_flags | CREATE_NO_WINDOW,
                      nullptr, paths.root.c_str(), &startup, &process)) {
    ThrowWin32(L"CreateProcessW(node.exe)");
  }
  return ChildProcess{unique_handle(process.hProcess),
                      unique_handle(process.hThread), process.dwProcessId};
}

[[nodiscard]] std::vector<std::wstring> SupervisorArguments(
    const RuntimePaths& paths) {
  return {paths.script.native(), L"--config", paths.config.native()};
}

[[nodiscard]] std::uint64_t RootHash(std::wstring value) {
  std::uint64_t hash = UINT64_C(14695981039346656037);
  for (wchar_t character : value) {
    character = static_cast<wchar_t>(towlower(character));
    hash ^= static_cast<std::uint16_t>(character);
    hash *= UINT64_C(1099511628211);
  }
  return hash;
}

[[nodiscard]] std::wstring MutexName(const fs::path& root) {
  std::wostringstream output;
  output << L"Local\\OceanWaveSupervisor_" << std::hex << std::setfill(L'0')
         << std::setw(16) << RootHash(root.native());
  return output.str();
}

class HostContext final {
 public:
  explicit HostContext(RuntimePaths paths) : paths_(std::move(paths)) {}

  void RequestGracefulStop(std::wstring_view reason) noexcept {
    bool expected = false;
    if (!stop_helper_started_.compare_exchange_strong(expected, true)) return;
    try {
      std::vector<std::wstring> arguments = SupervisorArguments(paths_);
      arguments.insert(arguments.end(),
                       {L"--request-stop", L"--reason", std::wstring(reason),
                        L"--timeout-seconds",
                        std::to_wstring(kGracefulStopTimeoutSeconds)});
      ChildProcess helper =
          CreateNodeProcess(paths_, arguments, CREATE_UNICODE_ENVIRONMENT);
      AppendLog(paths_.log, L"INFO",
                L"Requested graceful supervisor shutdown through helper PID " +
                    std::to_wstring(helper.process_id) + L" (" +
                    std::wstring(reason) + L").");
      // The helper owns no database worker and is intentionally outside the
      // supervisor job. Closing these handles does not terminate it.
    } catch (const std::exception& error) {
      AppendLog(paths_.log, L"ERROR",
                L"Could not start graceful shutdown helper: " +
                    Wide(error.what()));
    }
  }

  [[nodiscard]] const fs::path& log() const noexcept { return paths_.log; }

 private:
  RuntimePaths paths_;
  std::atomic_bool stop_helper_started_{false};
};

LRESULT CALLBACK HostWindowProcedure(HWND window, UINT message, WPARAM wparam,
                                     LPARAM lparam) noexcept {
  HostContext* context = reinterpret_cast<HostContext*>(
      GetWindowLongPtrW(window, GWLP_USERDATA));
  if (message == WM_NCCREATE) {
    const auto* create = reinterpret_cast<const CREATESTRUCTW*>(lparam);
    context = static_cast<HostContext*>(create->lpCreateParams);
    SetWindowLongPtrW(window, GWLP_USERDATA,
                      reinterpret_cast<LONG_PTR>(context));
  }
  switch (message) {
    case WM_QUERYENDSESSION:
      if (context != nullptr) {
        context->RequestGracefulStop(L"windows_session_end");
      }
      return TRUE;
    case WM_ENDSESSION:
      if (wparam != FALSE && context != nullptr) {
        context->RequestGracefulStop(L"windows_session_end");
      }
      return 0;
    case WM_CLOSE:
      if (context != nullptr) context->RequestGracefulStop(L"windows_close");
      return 0;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
    default:
      return DefWindowProcW(window, message, wparam, lparam);
  }
}

[[nodiscard]] HWND CreateHostWindow(HINSTANCE instance, HostContext* context) {
  WNDCLASSEXW window_class{};
  window_class.cbSize = sizeof(window_class);
  window_class.lpfnWndProc = HostWindowProcedure;
  window_class.hInstance = instance;
  window_class.lpszClassName = kWindowClass;
  if (RegisterClassExW(&window_class) == 0 &&
      GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
    ThrowWin32(L"RegisterClassExW");
  }
  HWND window = CreateWindowExW(
      WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, kWindowClass,
      L"Ocean-Wave Supervisor", WS_POPUP, 0, 0, 0, 0, nullptr, nullptr,
      instance, context);
  if (window == nullptr) ThrowWin32(L"CreateWindowExW");
  return window;
}

void WaitForChild(HANDLE process) {
  for (;;) {
    const DWORD result = MsgWaitForMultipleObjectsEx(
        1, &process, INFINITE, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
    if (result == WAIT_OBJECT_0) return;
    if (result == WAIT_OBJECT_0 + 1U) {
      MSG message{};
      while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
        if (message.message == WM_QUIT) continue;
        TranslateMessage(&message);
        DispatchMessageW(&message);
      }
      continue;
    }
    if (result == WAIT_FAILED) ThrowWin32(L"Wait for supervisor process");
    throw std::runtime_error("Unexpected supervisor wait result.");
  }
}

[[nodiscard]] int SelfTest(const RuntimePaths& paths) {
  unique_handle log = OpenInheritedLog(paths.log);
  unique_handle null_input = OpenInheritedNullInput();
  unique_handle job(CreateJobObjectW(nullptr, nullptr));
  if (!job) ThrowWin32(L"CreateJobObjectW self-test");
  (void)log;
  (void)null_input;
  AppendLog(paths.log, L"INFO",
            L"Native host self-test passed; node=" + paths.node.native());
  return 0;
}

void ConfigureCrashContainmentJob(HANDLE job) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                               &limits, sizeof(limits))) {
    ThrowWin32(L"SetInformationJobObject");
  }
}

[[nodiscard]] int RunSupervisor(HINSTANCE instance, RuntimePaths paths) {
  const std::wstring mutex_name = MutexName(paths.root);
  unique_handle mutex(CreateMutexW(nullptr, TRUE, mutex_name.c_str()));
  if (!mutex) ThrowWin32(L"CreateMutexW");
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    AppendLog(paths.log, L"INFO",
              L"A native supervisor host already owns this project root.");
    return 0;
  }

  if (!SetEnvironmentVariableW(L"OCEAN_WAVE_EXTERNAL_KEEP_AWAKE", L"1")) {
    ThrowWin32(L"Set OCEAN_WAVE_EXTERNAL_KEEP_AWAKE");
  }
  if (SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) == 0) {
    ThrowWin32(L"SetThreadExecutionState");
  }
  struct ExecutionStateGuard final {
    ~ExecutionStateGuard() { SetThreadExecutionState(ES_CONTINUOUS); }
  } execution_state_guard;

  // Run late in interactive-session shutdown so the Node supervisor can flush
  // its state after receiving WM_QUERYENDSESSION. Windows still owns the final
  // system-wide shutdown deadline.
  SetProcessShutdownParameters(0x100U, SHUTDOWN_NORETRY);

  unique_handle job(CreateJobObjectW(nullptr, nullptr));
  if (!job) ThrowWin32(L"CreateJobObjectW");
  // A normal stop waits for the Node supervisor (and its graceful worker
  // drains) before this handle closes. KILL_ON_JOB_CLOSE applies only if the
  // small native host crashes or is forcibly terminated, preventing an orphan
  // from retaining the ownership lock while Task Scheduler starts recovery.
  ConfigureCrashContainmentJob(job.get());

  HostContext context(paths);
  HWND window = CreateHostWindow(instance, &context);
  struct WindowGuard final {
    HWND value;
    HINSTANCE instance;
    ~WindowGuard() {
      if (value != nullptr) DestroyWindow(value);
      UnregisterClassW(kWindowClass, instance);
    }
  } window_guard{window, instance};

  ChildProcess child = CreateNodeProcess(
      paths, SupervisorArguments(paths),
      CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED);
  if (!AssignProcessToJobObject(job.get(), child.process.get())) {
    const DWORD code = GetLastError();
    TerminateProcess(child.process.get(), code);
    WaitForSingleObject(child.process.get(), 5000U);
    SetLastError(code);
    ThrowWin32(L"AssignProcessToJobObject");
  }
  if (ResumeThread(child.thread.get()) == static_cast<DWORD>(-1)) {
    const DWORD code = GetLastError();
    TerminateProcess(child.process.get(), code);
    WaitForSingleObject(child.process.get(), 5000U);
    SetLastError(code);
    ThrowWin32(L"ResumeThread");
  }
  child.thread.reset();
  AppendLog(paths.log, L"INFO",
            L"Started windowless Node supervisor PID " +
                std::to_wstring(child.process_id) + L".");

  WaitForChild(child.process.get());
  DWORD exit_code = ERROR_GEN_FAILURE;
  if (!GetExitCodeProcess(child.process.get(), &exit_code)) {
    ThrowWin32(L"GetExitCodeProcess");
  }
  AppendLog(paths.log, exit_code == 0 ? L"INFO" : L"ERROR",
            L"Node supervisor exited with code " +
                std::to_wstring(exit_code) + L".");
  return static_cast<int>(exit_code);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX |
               SEM_NOOPENFILEERRORBOX);
  fs::path log;
  try {
    const Options options = ParseOptions();
    RuntimePaths paths = ResolvePaths(options);
    log = paths.log;
    if (options.self_test) return SelfTest(paths);
    return RunSupervisor(instance, std::move(paths));
  } catch (const std::exception& error) {
    if (!log.empty()) {
      AppendLog(log, L"ERROR", Wide(error.what()));
    } else {
      OutputDebugStringW((L"Ocean-Wave native supervisor host: " +
                          Wide(error.what()) + L"\r\n")
                             .c_str());
    }
    return static_cast<int>(ERROR_BAD_ENVIRONMENT);
  } catch (...) {
    if (!log.empty()) {
      AppendLog(log, L"ERROR", L"Unknown native host failure.");
    }
    return static_cast<int>(ERROR_UNHANDLED_EXCEPTION);
  }
}
