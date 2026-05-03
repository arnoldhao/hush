#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

const WIDTH = 540
const HEIGHT = 380
const OUTPUT_DIR = join(process.cwd(), 'build')

app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('force-device-scale-factor', '1')

app
  .whenReady()
  .then(async () => {
    await mkdir(OUTPUT_DIR, { recursive: true })
    await renderBackground()
  })
  .then(() => app.quit())
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })

async function renderBackground() {
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: false,
    resizable: false,
    webPreferences: {
      offscreen: true,
      sandbox: true
    }
  })

  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(createHtml())}`)
  await window.webContents.executeJavaScript('document.fonts.ready')

  const image = await window.webContents.capturePage()
  const imageSize = image.getSize()
  const retinaImage =
    imageSize.width >= WIDTH * 2 && imageSize.height >= HEIGHT * 2
      ? image
      : image.resize({ width: WIDTH * 2, height: HEIGHT * 2, quality: 'best' })

  await writeFile(
    join(OUTPUT_DIR, 'dmg-background.png'),
    retinaImage.resize({ width: WIDTH, height: HEIGHT, quality: 'best' }).toPNG()
  )
  await writeFile(join(OUTPUT_DIR, 'dmg-background@2x.png'), retinaImage.toPNG())
  window.destroy()
}

function createHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      * {
        box-sizing: border-box;
      }

      html,
      body {
        width: ${WIDTH}px;
        height: ${HEIGHT}px;
        margin: 0;
        overflow: hidden;
        background: #f7f8f5;
      }

      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif;
        color: #1f241f;
      }

      .canvas {
        position: relative;
        width: ${WIDTH}px;
        height: ${HEIGHT}px;
        overflow: hidden;
        background:
          radial-gradient(circle at 50% 0%, rgba(234, 88, 12, 0.12), transparent 42%),
          linear-gradient(180deg, #fff7ed 0%, #ffedd5 64%, #fff7ed 100%);
      }

      .canvas::before {
        content: "";
        position: absolute;
        inset: 16px;
        border: 1px solid rgba(194, 65, 12, 0.12);
        border-radius: 8px;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.46), rgba(255, 247, 237, 0.1));
      }

      .title {
        position: absolute;
        top: 32px;
        left: 0;
        width: 100%;
        text-align: center;
        font-size: 28px;
        font-weight: 800;
        line-height: 1.1;
        color: #431407;
      }

      .subtitle {
        position: absolute;
        top: 70px;
        left: 0;
        width: 100%;
        text-align: center;
        color: #7c2d12;
        font-size: 13px;
        font-weight: 650;
      }

      .drop-zone {
        position: absolute;
        top: 106px;
        width: 96px;
        height: 96px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.48);
        border: 1px solid rgba(194, 65, 12, 0.12);
        box-shadow: 0 18px 56px rgba(154, 52, 18, 0.12);
      }

      .drop-zone.app {
        left: 84px;
      }

      .drop-zone.applications {
        right: 84px;
      }

      .arrow {
        position: absolute;
        top: 152px;
        left: 228px;
        width: 84px;
        height: 3px;
        border-radius: 999px;
        background: #ea580c;
        box-shadow: 0 0 0 5px rgba(234, 88, 12, 0.1);
      }

      .arrow::after {
        content: "";
        position: absolute;
        top: -6px;
        right: -1px;
        width: 15px;
        height: 15px;
        border-top: 3px solid #ea580c;
        border-right: 3px solid #ea580c;
        transform: rotate(45deg);
      }

      .instruction {
        position: absolute;
        left: 56px;
        right: 56px;
        top: 226px;
        text-align: center;
        color: #431407;
        font-size: 16px;
        font-weight: 750;
        line-height: 1.35;
      }

    </style>
  </head>
  <body>
    <main class="canvas">
      <div class="title">Install Hush</div>
      <div class="subtitle">Drag Hush into Applications</div>
      <div class="drop-zone app"></div>
      <div class="arrow"></div>
      <div class="drop-zone applications"></div>
      <div class="instruction">Move Hush.app to the Applications folder.</div>
    </main>
  </body>
</html>`
}
