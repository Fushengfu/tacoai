try {
  // Simulate what the real main.cjs does
  const electron = require("electron");
  
  // Check if electron loaded correctly
  if (typeof electron === 'string' || !electron.app) {
    console.log("ERROR: electron module not loaded correctly, type:", typeof electron);
    process.exit(1);
  }

  const pty = require("node-pty");
  
  electron.app.whenReady().then(() => {
    console.log("App ready, testing pty.spawn...");
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      const p = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.env.HOME,
        env: { ...process.env, TERM: 'xterm-256color' }
      });
      console.log("PTY spawn OK, pid:", p.pid);
      p.kill();
      console.log("PTY killed successfully");
    } catch (e) {
      console.log("PTY spawn FAILED:", e.message);
    }
    electron.app.quit();
  });
} catch (e) {
  console.log("Top-level error:", e.message);
  process.exit(1);
}
