@echo off
:: Run as Administrator — opens Windows Firewall for RabiTech on LAN
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%~dp0allow-lan.ps1\"'"
pause
