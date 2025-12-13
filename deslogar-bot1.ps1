# Script para deslogar bot1 completamente (Windows PowerShell)

Write-Host "🛑 Parando bot1..." -ForegroundColor Yellow
pm2 stop bot1

Write-Host "⏳ Aguardando 3 segundos..." -ForegroundColor Yellow
Start-Sleep -Seconds 3

Write-Host "🗑️ Deletando tokens do bot1..." -ForegroundColor Red
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "tokens-bot1"

Write-Host "🗑️ Deletando backups de autenticação..." -ForegroundColor Red
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "auth-backups"

Write-Host "✅ Tokens deletados!" -ForegroundColor Green
Write-Host ""
Write-Host "🔄 Para reiniciar o bot e gerar novo QR code:" -ForegroundColor Cyan
Write-Host "   pm2 start bot1" -ForegroundColor White
Write-Host ""
Write-Host "📱 Após reiniciar, escaneie o novo QR code que aparecerá" -ForegroundColor Cyan


