@echo off
chcp 65001 >nul
echo 即将请求管理员权限，用于修改系统级 JAVA_HOME 和 PATH。
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"%~dp0set-java21-admin.ps1\"'"
