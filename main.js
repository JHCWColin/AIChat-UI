const { app, BrowserWindow } = require("electron");
const path = require("path");

function createWindow(htmlFile = "index.html") {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        icon: path.join(__dirname, "favicon.ico"),
        autoHideMenuBar: true,

        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            nativeWindowOpen: true
        }
    });

    win.loadFile(htmlFile);

    // 允许 window.open()
    win.webContents.setWindowOpenHandler(({ url }) => {
        return {
            action: "allow"
        };
    });

    return win;
}

app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});