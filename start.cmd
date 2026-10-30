@echo off
rem Double-click to jam locally on Windows: starts a tiny local server (PowerShell, nothing to
rem install), finds your Stems folder and opens the app. Close this window to stop the server.
rem Options are passed through, e.g.:  start.cmd -Stems "D:\Daft Punk\Stems" -Port 8200
title Dream Chamber Remixed - local server
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1" %*
if errorlevel 1 pause
