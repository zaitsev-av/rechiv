package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"rechiv/desktop/assets"
	"rechiv/desktop/internal/api"
	"rechiv/desktop/internal/controller"
	"rechiv/desktop/internal/engine"
	"rechiv/desktop/internal/extensiondist"
	"rechiv/desktop/internal/library"
	"rechiv/desktop/internal/mcpserver"
	"rechiv/desktop/internal/onboarding"
	"rechiv/desktop/internal/security"
	"rechiv/desktop/internal/store"
	"rechiv/desktop/internal/tray"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

var version = "dev"

func main() {
	command, args, err := parseCommand(os.Args[1:])
	if err != nil {
		log.New(os.Stderr, "rechiv: ", 0).Fatal(err)
	}
	switch command {
	case "help":
		fmt.Print(commandHelp)
		return
	case "mcp":
		if err := runMCP(args); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return
			}
			log.New(os.Stderr, "rechiv mcp: ", log.LstdFlags).Fatal(err)
		}
		return
	}

	app, err := start(args)
	if err != nil {
		log.Fatalf("rechiv: %v", err)
	}

	// Трей занимает главную горутину, поэтому сигналы обрабатываются в фоне.
	go func() {
		app.awaitStop()
		tray.Quit()
	}()

	tray.Run(tray.Options{
		Icon:          assets.MenuBarIcon,
		Version:       version,
		SessionsURL:   app.sessionsURL,
		OnboardingURL: app.onboardingURL,
		DataDir:       app.dataDir,
		Status:        app.trayStatus,
		Logger:        app.logger,
	})

	if err := app.stop(); err != nil {
		log.Fatalf("rechiv: %v", err)
	}
}

func runMCP(args []string) error {
	defaultDataDir, err := dataDir()
	if err != nil {
		return err
	}

	flags := flag.NewFlagSet("rechiv mcp", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)

	dir := flags.String("data-dir", defaultDataDir, "application data directory")

	if err := flags.Parse(args); err != nil {
		return err
	}

	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	server := mcpserver.NewServer(mcpserver.DefaultConfig(version), library.New(*dir))

	return server.Run(ctx, &mcp.StdioTransport{})
}

func start(args []string) (result *application, err error) {
	defaultDataDir, err := dataDir()
	if err != nil {
		return nil, err
	}
	defaultWorker := findEngineWorker()

	listenAddress := flag.String("listen", "127.0.0.1:9876", "local HTTP listen address")
	appDataDir := flag.String("data-dir", defaultDataDir, "application data directory")
	pythonBinary := flag.String("python", findPython(), "Python executable used by the GigaAM worker")
	engineWorker := flag.String("engine-worker", defaultWorker, "path to engine/worker.py")
	serviceDir := flag.String("service-dir", "", "development path to the Python service package")
	ffmpegBinary := flag.String("ffmpeg", findFFmpeg(), "ffmpeg executable")
	modelName := flag.String("model", "v3_e2e_ctc", "GigaAM model")
	engineKind := flag.String("engine", "onnx", "inference engine: onnx or torch")
	onnxModelDir := flag.String("onnx-model-dir", findOnnxModelDir(defaultDataDir), "directory with the ONNX model and manifest")
	device := flag.String("device", "auto", "GigaAM device: auto, cuda, mps or cpu")
	threads := flag.Int("threads", 6, "PyTorch CPU thread count")
	allowedExtensionID := flag.String(
		"allowed-extension-id",
		api.DefaultExtensionID,
		"ID расширения Chrome; значение any отключает проверку для разработки",
	)

	keepAudio := flag.Bool("keep-audio", false, "keep chunk audio after finalization for engine comparison")
	if err := flag.CommandLine.Parse(args); err != nil {
		return nil, err
	}

	if flag.NArg() != 0 {
		return nil, unknownCommand(flag.Arg(0))
	}

	instanceLock, err := acquireInstanceLock(*appDataDir)
	if err != nil {
		return nil, err
	}
	defer func() {
		if result == nil {
			_ = instanceLock.Close()
		}
	}()

	logger, closeLog, err := openLogger(*appDataDir)
	if err != nil {
		return nil, err
	}

	extensionDir := prepareExtensionDir(*appDataDir, logger)
	onboardingService := onboarding.New(extensionDir, nil, nil)
	sessionStore, err := store.New(*appDataDir)
	if err != nil {
		return nil, fmt.Errorf("open session store: %w", err)
	}

	apiToken, err := security.EnsureToken(*appDataDir, "api_token")
	if err != nil {
		return nil, fmt.Errorf("create API token: %w", err)
	}

	if *engineKind != "onnx" && *engineKind != "torch" {
		return nil, fmt.Errorf("unknown engine %q: expected onnx or torch", *engineKind)
	}

	if *engineKind == "onnx" && *onnxModelDir == "" {
		return nil, errors.New("recognition model not found: reinstall the application")
	}

	engineCommand := []string{
		*pythonBinary,
		*engineWorker,
		"--model", *modelName,
		"--device", *device,
		"--threads", fmt.Sprintf("%d", *threads),
		"--engine", *engineKind,
	}

	if *engineKind == "onnx" {
		engineCommand = append(engineCommand, "--onnx-model-dir", *onnxModelDir)
	}

	if *serviceDir != "" {
		engineCommand = append(engineCommand, "--service-dir", *serviceDir)
	}

	inference, err := engine.NewProcess(engineCommand, logger)
	if err != nil {
		return nil, err
	}

	control := controller.New(
		sessionStore,
		inference,
		controller.FFmpegConverter{Binary: *ffmpegBinary},
		logger,
	)

	control.KeepAudio = *keepAudio
	if err := control.Start(); err != nil {
		return nil, fmt.Errorf("start controller: %w", err)
	}

	webUI := findWebUIDir()
	sessionsURL := ""
	onboardingURL := ""
	options := []api.Option{api.WithOnboarding(onboardingService)}
	if webUI != "" {
		options = append(options, api.WithWebUI(webUI))
		sessionsURL = "http://" + *listenAddress + "/"
		onboardingURL = "http://" + *listenAddress + "/onboarding.html"
	}

	handler := api.New(control, apiToken, *allowedExtensionID, version, logger, options...)
	httpServer := &http.Server{
		Addr:              *listenAddress,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       2 * time.Minute,
		WriteTimeout:      2 * time.Minute,
		IdleTimeout:       2 * time.Minute,
	}

	listener, err := net.Listen("tcp", *listenAddress)
	if err != nil {
		control.Close()
		return nil, err
	}

	logger.Printf("Rechiv is ready at http://%s", *listenAddress)
	logger.Printf("Data directory: %s", *appDataDir)
	logger.Printf("Python: %s", *pythonBinary)
	logger.Printf("Engine worker: %s", *engineWorker)

	app := &application{
		control:       control,
		httpServer:    httpServer,
		logger:        logger,
		dataDir:       *appDataDir,
		sessionsURL:   sessionsURL,
		onboardingURL: onboardingURL,
		serverErrors:  make(chan error, 1),
		closeLog:      closeLog,
		instanceLock:  instanceLock,
	}

	go func() {
		app.serverErrors <- httpServer.Serve(listener)
	}()

	if opened, openErr := onboardingService.OpenFirstOnboarding(*appDataDir, onboardingURL); openErr != nil {
		logger.Printf("Не удалось открыть онбординг: %v", openErr)
	} else if opened {
		logger.Printf("Открыта страница первоначальной настройки: %s", onboardingURL)
	}
	return app, nil
}

type application struct {
	control       *controller.Controller
	httpServer    *http.Server
	logger        *log.Logger
	dataDir       string
	sessionsURL   string
	onboardingURL string
	instanceLock  *os.File
	closeLog      func()
	serverErrors  chan error
}

func (a *application) awaitStop() {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	select {
	case received := <-signals:
		a.logger.Printf("Received %s, stopping", received)
	case err := <-a.serverErrors:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			a.logger.Printf("HTTP server stopped: %v", err)
		}
	}
}

func (a *application) stop() error {
	// Контроллер закрывается после сервера, чтобы последний запрос не попал в остановленную очередь.
	defer a.instanceLock.Close()
	defer a.closeLog()
	defer a.control.Close()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return a.httpServer.Shutdown(shutdownCtx)
}

func (a *application) trayStatus() tray.Status {
	state, detail := a.control.EngineStatus()
	return tray.Status{Engine: string(state), Detail: detail}
}

const logFileLimit = 5 << 20

func openLogger(dataDir string) (*log.Logger, func(), error) {
	stderrOnly := log.New(os.Stderr, "", log.LstdFlags|log.Lmicroseconds)
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, func() {}, err
	}

	path := filepath.Join(dataDir, "rechiv.log")
	if info, err := os.Stat(path); err == nil && info.Size() > logFileLimit {
		_ = os.Remove(path)
	}

	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		stderrOnly.Printf("cannot open log file %s: %v", path, err)
		return stderrOnly, func() {}, nil
	}

	logger := log.New(io.MultiWriter(os.Stderr, file), "", log.LstdFlags|log.Lmicroseconds)

	return logger, func() { _ = file.Close() }, nil
}

func dataDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}

	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "Rechiv"), nil
	}

	return filepath.Join(home, ".rechiv"), nil
}

func bundleResources() string {
	executable, err := os.Executable()
	if err != nil {
		return ""
	}

	if resolved, resolveErr := filepath.EvalSymlinks(executable); resolveErr == nil {
		executable = resolved
	}

	dir := filepath.Dir(executable)
	for _, candidate := range []string{
		filepath.Join(dir, "..", "Resources"),
		filepath.Join(dir, "resources"),
	} {
		if info, statErr := os.Stat(candidate); statErr == nil && info.IsDir() {
			return filepath.Clean(candidate)
		}
	}

	return ""
}

func bundleResource(parts ...string) string {
	root := bundleResources()
	if root == "" {
		return ""
	}

	return filepath.Join(append([]string{root}, parts...)...)
}

func projectPaths(parts ...string) []string {
	roots := make([]string, 0, 3)
	if executable, err := os.Executable(); err == nil {
		roots = append(roots, filepath.Join(filepath.Dir(executable), ".."))
	}
	if workingDir, err := os.Getwd(); err == nil {
		roots = append(roots, workingDir, filepath.Join(workingDir, ".."))
	}
	paths := make([]string, 0, len(roots))
	for _, root := range roots {
		paths = append(paths, filepath.Join(append([]string{root}, parts...)...))
	}

	return paths
}

func findEngineWorker() string {
	if path := bundleResource("engine", "worker.py"); isRegularFile(path) {
		return path
	}
	for _, candidate := range projectPaths("desktop", "engine", "worker.py") {
		if isRegularFile(candidate) {
			return filepath.Clean(candidate)
		}
	}

	return filepath.Join("desktop", "engine", "worker.py")
}

func findOnnxModelDir(dataDir string) string {
	if path := bundleResource("model"); isDirectory(path) {
		return path
	}
	if dataDir != "" {
		if candidate := filepath.Join(dataDir, "model"); isDirectory(candidate) {
			return candidate
		}
	}
	for _, variant := range []string{"onnx-int8", "onnx"} {
		for _, candidate := range projectPaths("build", variant) {
			if isDirectory(candidate) {
				return filepath.Clean(candidate)
			}
		}
	}

	return ""
}

func findWebUIDir() string {
	if path := bundleResource("webui"); isDirectory(path) {
		return path
	}
	for _, candidate := range projectPaths("build", "webui") {
		if isDirectory(candidate) {
			return filepath.Clean(candidate)
		}
	}

	return ""
}

func prepareExtensionDir(dataDir string, logger *log.Logger) string {
	target := filepath.Join(dataDir, "extension")
	bundled := bundleResource("extension")

	if isDirectory(bundled) {
		changed, err := extensiondist.Sync(bundled, target)
		if err != nil {
			logger.Printf("Не удалось синхронизировать расширение: %v", err)
		} else if changed {
			logger.Printf("Расширение синхронизировано в %s", target)
		}
		if isExtensionDir(target) {
			return target
		}
	}

	for _, candidate := range projectPaths("extension", "dist") {
		if isExtensionDir(candidate) {
			return filepath.Clean(candidate)
		}
	}

	if isExtensionDir(target) {
		return target
	}

	return ""
}

func isExtensionDir(path string) bool {
	return isDirectory(path) && isRegularFile(filepath.Join(path, "manifest.json"))
}

func findFFmpeg() string {
	if path := bundleResource("ffmpeg"); isExecutableFile(path) {
		return path
	}

	return "ffmpeg"
}

func findPython() string {
	if path := bundleResource("python", "bin", "python3"); isExecutableFile(path) {
		return path
	}
	for _, candidate := range projectPaths("service", ".venv", "bin", "python") {
		if isExecutableFile(candidate) {
			return filepath.Clean(candidate)
		}
	}
	for _, candidate := range []string{"python3.13", "python3.12", "python3.11", "python3.10"} {
		if path, err := exec.LookPath(candidate); err == nil {
			return path
		}
	}

	return "python3"
}

func isExecutableFile(path string) bool {
	if path == "" {
		return false
	}

	info, err := os.Stat(path)

	return err == nil && !info.IsDir() && info.Mode()&0o111 != 0
}

func isRegularFile(path string) bool {
	if path == "" {
		return false
	}

	info, err := os.Stat(path)

	return err == nil && !info.IsDir()
}

func isDirectory(path string) bool {
	if path == "" {
		return false
	}

	info, err := os.Stat(path)

	return err == nil && info.IsDir()
}
