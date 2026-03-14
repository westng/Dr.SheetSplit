<template>
  <RouterView />
</template>

<style>
:root {
  font-family:
    "SF Pro Text",
    "SF Pro Display",
    "PingFang SC",
    "Helvetica Neue",
    sans-serif;
  font-size: 14px;
  line-height: 1.45;
  font-weight: 400;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  -webkit-text-size-adjust: 100%;
}

:root,
:root[data-theme="dark"] {
  color: #f2f2f7;
  background-color: #1c1c1e;
  color-scheme: dark;
  --bg-main: #1c1c1e;
  --bg-panel: #232326;
  --bg-card: #2c2c2e;
  --bg-input: #303033;
  --bg-strong: #3a3a3c;
  --text-main: #f2f2f7;
  --text-muted: #8e8e93;
  --stroke-soft: #454547;
  --accent: #0a84ff;
  --accent-strong: #0a84ff;
  --focus-ring: rgba(10, 132, 255, 0.32);
  --shadow-soft: 0 12px 28px rgba(0, 0, 0, 0.42);
  --btn-bg: #454549;
  --btn-bg-hover: #4d4d52;
  --btn-border: #66666b;
  --switch-track-bg: #3a3a3c;
  --switch-track-active: #5a5a5f;
  --switch-thumb: #d1d1d6;
  --surface-muted: #262629;
  --drop-zone-bg: #323236;
  --danger: #d18f8f;
  --glass-blur: 10px;
}

:root[data-theme="light"] {
  color: #1f1f21;
  background-color: #eef0f3;
  color-scheme: light;
  --bg-main: #eef0f3;
  --bg-panel: #f8f9fb;
  --bg-card: #ffffff;
  --bg-input: #f3f4f7;
  --bg-strong: #e7e9ef;
  --text-main: #1f1f21;
  --text-muted: #6e727b;
  --stroke-soft: #d3d7df;
  --shadow-soft: 0 10px 22px rgba(60, 66, 87, 0.11);
  --btn-bg: #eceff5;
  --btn-bg-hover: #e2e6ef;
  --btn-border: #cad0db;
  --switch-track-bg: #d5dae4;
  --switch-track-active: #c7cedb;
  --switch-thumb: #ffffff;
  --surface-muted: #f3f5f8;
  --drop-zone-bg: #f1f3f7;
  --danger: #b35b5b;
  --glass-blur: 8px;
}

:root[data-glass="transparent"] {
  --glass-blur: 20px;
}

:root[data-glass="tinted"] {
  --glass-blur: 10px;
}

:root[data-theme="dark"][data-glass="transparent"] {
  --bg-panel: rgba(35, 35, 38, 0.74);
  --bg-card: rgba(44, 44, 46, 0.76);
  --bg-input: rgba(48, 48, 51, 0.78);
  --bg-strong: rgba(58, 58, 60, 0.82);
}

:root[data-theme="dark"][data-glass="tinted"] {
  --bg-panel: rgba(34, 38, 44, 0.9);
  --bg-card: rgba(43, 47, 54, 0.9);
  --bg-input: rgba(48, 52, 59, 0.92);
  --bg-strong: rgba(61, 66, 74, 0.94);
}

:root[data-theme="light"][data-glass="transparent"] {
  --bg-panel: rgba(248, 249, 251, 0.7);
  --bg-card: rgba(255, 255, 255, 0.74);
  --bg-input: rgba(243, 244, 247, 0.76);
  --bg-strong: rgba(231, 233, 239, 0.84);
}

:root[data-theme="light"][data-glass="tinted"] {
  --bg-panel: rgba(241, 243, 248, 0.9);
  --bg-card: rgba(250, 251, 253, 0.93);
  --bg-input: rgba(238, 241, 247, 0.92);
  --bg-strong: rgba(224, 228, 236, 0.95);
}

:root {

  --fs-caption: 12px;
  --fs-sm: 13px;
  --fs-md: 14px;
  --fs-lg: 16px;
  --fs-xl: 20px;
  --fs-2xl: 24px;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  height: 100%;
  background: var(--bg-main);
  color: var(--text-main);
  transition: background-color 160ms ease, color 160ms ease;
  overflow: hidden;
}

html {
  height: 100%;
  overflow: hidden;
}

#app {
  height: 100%;
  overflow: hidden;
}
</style>
