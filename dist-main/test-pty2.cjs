try {
  const electron = require("electron");
  console.log("electron type:", typeof electron);
  console.log("electron.app type:", typeof electron.app);
  
  if (!electron.app) {
    console.log("Electron module not available in main process - checking NODE_PATH...");
    console.log("__dirname:", __dirname);
    console.log("module.paths:", module.paths.slice(0, 5));
    process.exit(1);
  }
  
  electron.app.whenReady().then(() => {
    console.log("App ready!");
    electron.app.quit();
  });
} catch (e) {
  console.log("Error:", e.message);
}
