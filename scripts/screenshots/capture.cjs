// Renders the real pet and settings pages with sample data into docs/images/*.png.
// Usage: npx electron scripts/screenshots/capture.cjs        (MAI_SPRITE=<set> to show your own sprites)
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const out = path.join(root, "docs", "images");
const renderer = path.join(root, "src", "app", "renderer");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.setName("mai-screenshots");
// Each shot closes its window; don't let that end the run.
app.on("window-all-closed", () => {});

async function shot(name, page, size, script, bg = "#5d7290") {
	const win = new BrowserWindow({
		...size,
		show: false,
		backgroundColor: bg,
		webPreferences: { preload: path.join(__dirname, "stub-preload.cjs"), contextIsolation: false, sandbox: false, backgroundThrottling: false },
	});
	// Loading the same file right after another window closed is sometimes aborted (ERR_FAILED); retry.
	for (let i = 0; ; i++) {
		try {
			await win.loadFile(path.join(renderer, page));
			break;
		} catch (e) {
			if (i >= 3) throw e;
			await wait(500);
		}
	}
	await wait(700);
	if (script) await win.webContents.executeJavaScript(script);
	await wait(1800);
	fs.writeFileSync(path.join(out, `${name}.png`), (await win.capturePage()).toPNG());
	console.log(`docs/images/${name}.png`);
	win.destroy();
}

app.whenReady().then(async () => {
	fs.mkdirSync(out, { recursive: true });
	const reply = [
		"Dạ? Có **chị đây** rồi. Nghe chị nói này, nhóc:",
		"",
		"1. **Ngủ sớm**, trước 12 giờ.",
		"2. Uống *đủ nước*, ít nhất 2 lít.",
		"3. Đừng ngồi máy tính quá `90 phút` liền.",
		"",
		"Ngoan thì chị thưởng cho một *headpat*. Còn không thì... chị dỗi đấy!",
	].join("\n");
	await shot("chat", "pet.html", { width: 400, height: 760 }, `__demo.pose({mode:"chat",behaviour:"idle",facing:"left"}); __demo.say(${JSON.stringify(reply)}, "stern")`);
	await shot("planner", "pet.html", { width: 400, height: 760 }, `__demo.pose({mode:"chat",behaviour:"idle",facing:"left"}); __demo.click("btn-planner")`);
	await shot("roam", "pet.html", { width: 170, height: 200 }, `__demo.pose({mode:"roam",behaviour:"walk",facing:"right"})`);
	await shot("settings-history", "settings.html", { width: 980, height: 620 }, `document.querySelector('[data-tab=history]').click(); setTimeout(() => document.querySelector('#history-list li').click(), 300)`, "#ffffff");
	app.quit();
});
