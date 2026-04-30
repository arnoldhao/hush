<div align="center">
  <img src="./build/icon.png" width="112" alt="Hush icon" />
  <h1>Hush</h1>
  <p><strong>A customizable Lo-Fi live radio player for desktop</strong></p>
  <p>
    <strong>English</strong> ·
    <a href="./README_zh-CN.md">简体中文</a>
  </p>
  <p>
    <img src="https://img.shields.io/github/v/tag/arnoldhao/hush?label=version" alt="Latest version" />
    <img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License" />
    <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey" alt="Supported platforms" />
    <img src="https://img.shields.io/badge/stack-Electron%20%E2%80%A2%20React%20%E2%80%A2%20SQLite-green" alt="Tech stack" />
  </p>
</div>

## Overview

Hush is a lightweight desktop player built around YouTube Live Lo-Fi channels. It opens directly into a focused player, ships with a curated Hush channel list, and lets you add active or scheduled YouTube Live streams to your own channel groups.

Hush grew out of the online music live-radio module in [XiaDown](https://github.com/arnoldhao/xiadown). If you need a video download tool with online music support, XiaDown includes YouTube Lo-Fi stations and YouTube Music, plus material downloads, transcoding, and local library management for thousands of online video sites.

## Core Capabilities

- **Three player shapes**: mini player, audio mode, and video mode for different desktop spaces and listening habits.
- **Built-in and custom channels**: start from the recommended Hush catalog, refresh the list, or add your favorite active and scheduled YouTube Live channels with custom titles and groups.
- **Minimal, flexible appearance**: a clean interface with light, dark, and system modes, multiple theme packs, custom accent colors, font options, proxy settings, and tray or menu bar behavior.

## Product Preview

<p align="center">
  <img src="./images/audio.png" alt="Hush audio mode" width="88%" />
</p>

<p align="center">
  <img src="./images/video.png" alt="Hush video mode" width="88%" />
</p>

<p align="center">
  <img src="./images/mini.png" alt="Hush mini player" width="68%" />
</p>

## Quick Start

### Download and install

Download links will be added below after release builds are available. Older releases will be available on [GitHub Releases](https://github.com/arnoldhao/hush/releases).

| Platform | Architecture | Package   | Download |
| -------- | ------------ | --------- | -------- |
| macOS    | Universal    | Archive   |          |
| Windows  | x64          | Installer |          |
| Windows  | x64          | Portable  |          |

### First launch

1. `macOS`: unzip the package and move `Hush.app` to the Applications folder. If macOS says the app cannot be opened or is damaged, run `sudo xattr -rd com.apple.quarantine /Applications/Hush.app`.
2. `Windows`: run the `.exe` installer directly, or unzip the portable package and launch it. If SmartScreen appears on first launch, choose `More info -> Run anyway`.
3. Hush opens the live player by default. Use Settings to choose language, appearance, proxy, menu bar or tray behavior, and update preferences, then pick a built-in channel or add your own YouTube Live link.

## Acknowledgements

Hush is built on top of excellent open-source projects and services. The desktop experience, live playback, local storage, updates, and frontend interface all depend on these foundations.

| Category            | Homepage                                                                                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop Framework   | <a href="https://www.electronjs.org/" target="_blank" rel="noreferrer">Electron</a> / <a href="https://react.dev/" target="_blank" rel="noreferrer">React</a>                                                                                                                                           |
| Live Playback       | <a href="https://www.youtube.com/live" target="_blank" rel="noreferrer">YouTube Live</a> / <a href="https://developers.google.com/youtube/iframe_api_reference" target="_blank" rel="noreferrer">YouTube IFrame Player API</a>                                                                          |
| Local Storage       | <a href="https://www.sqlite.org/" target="_blank" rel="noreferrer">SQLite</a> / <a href="https://github.com/WiseLibs/better-sqlite3" target="_blank" rel="noreferrer">better-sqlite3</a> / <a href="https://github.com/sindresorhus/electron-store" target="_blank" rel="noreferrer">electron-store</a> |
| Build and Updates   | <a href="https://electron-vite.org/" target="_blank" rel="noreferrer">electron-vite</a> / <a href="https://www.electron.build/" target="_blank" rel="noreferrer">electron-builder</a> / <a href="https://www.electron.build/auto-update" target="_blank" rel="noreferrer">electron-updater</a>          |
| Frontend Experience | <a href="https://vite.dev/" target="_blank" rel="noreferrer">Vite</a> / <a href="https://www.typescriptlang.org/" target="_blank" rel="noreferrer">TypeScript</a> / <a href="https://lucide.dev/" target="_blank" rel="noreferrer">Lucide</a>                                                           |

## Collaboration

- The project is under active development and is not accepting pull requests for now. Feedback, bug reports, and usage scenarios are welcome through [GitHub Issues](https://github.com/arnoldhao/hush/issues) or email.
- This repository is licensed under `Apache-2.0`. See [LICENSE](./LICENSE).

## Contact

- Website: <https://dreamapp.cc/>
- Email: <xunruhao@gmail.com>
