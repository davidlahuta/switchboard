#:sdk Aspire.AppHost.Sdk@13.5.3
#:package Aspire.Hosting.JavaScript@13.5.3

// Switchboard dev orchestration: `aspire run` starts the daemon (with file watching) and the
// Vite dev server for the web UI, with logs and health in the Aspire dashboard.

var builder = DistributedApplication.CreateBuilder(args);

// The daemon must own a fixed, well-known port: Claude Code hooks, MCP shims and session
// runners all connect to it, so it is not proxied.
var daemon = builder.AddJavaScriptApp("daemon", ".", "dev:daemon")
    .WithHttpEndpoint(port: 4477, env: "SWITCHBOARD_PORT", isProxied: false)
    .WithHttpHealthCheck("/healthz");

builder.AddViteApp("web", "./web")
    .WithEnvironment("SWITCHBOARD_URL", daemon.GetEndpoint("http"))
    .WithReference(daemon)
    .WaitFor(daemon);

builder.Build().Run();
