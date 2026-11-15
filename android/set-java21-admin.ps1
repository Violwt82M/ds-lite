# 需要管理员权限：把机器级 JAVA_HOME/PATH 指向 JDK 21，并移除 Oracle Java 8 的 PATH 项
$ErrorActionPreference = 'Stop'
$jdk = 'C:\Java\jdk-21.0.13+9'
if (-not (Test-Path (Join-Path $jdk 'bin\java.exe'))) { Write-Host "找不到 $jdk"; pause; exit 1 }

$oldPath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Set-Content -Path "C:\Java\PATH-backup-$stamp.txt" -Value $oldPath -Encoding UTF8

[Environment]::SetEnvironmentVariable('JAVA_HOME', $jdk, 'Machine')
$entries = $oldPath -split ';' | Where-Object {
  $_ -and $_ -notmatch 'Oracle\\Java\\java8path' -and $_ -notmatch 'jdk-21'
}
[Environment]::SetEnvironmentVariable('Path', (@("$jdk\bin") + $entries -join ';'), 'Machine')

Write-Host '已设置：'
Write-Host ('  JAVA_HOME = ' + [Environment]::GetEnvironmentVariable('JAVA_HOME', 'Machine'))
Write-Host ('  PATH 首项 = ' + (([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';')[0]))
Write-Host ('  旧 PATH 已备份到 C:\Java\PATH-backup-' + $stamp + '.txt')
Write-Host ''
Write-Host 'Java 8 没有卸载，只是不再出现在 PATH 里；需要时可用完整路径调用。'
Read-Host '按回车关闭'
