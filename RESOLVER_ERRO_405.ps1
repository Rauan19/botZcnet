# Script para resolver erro 405 (Connection Failure)
Write-Host "🔧 Resolvendo erro 405 (Connection Failure)..." -ForegroundColor Cyan
Write-Host ""

# Pergunta qual bot está com problema
Write-Host "Qual bot está com erro 405?" -ForegroundColor Yellow
Write-Host "1 - Bot 1 (porta 3009)"
Write-Host "2 - Bot 2 (porta 3010)"
Write-Host "3 - Bot 3 (porta 3011)"
Write-Host "4 - Todos os bots"
Write-Host ""
$opcao = Read-Host "Digite o número (1-4)"

$tokensToClean = @()

switch ($opcao) {
    "1" { $tokensToClean = @("tokens-bot1") }
    "2" { $tokensToClean = @("tokens-bot2") }
    "3" { $tokensToClean = @("tokens-bot3") }
    "4" { $tokensToClean = @("tokens-bot1", "tokens-bot2", "tokens-bot3") }
    default { 
        Write-Host "Opção inválida!" -ForegroundColor Red
        exit
    }
}

Write-Host ""
Write-Host "🛑 Parando processos Node.js..." -ForegroundColor Yellow
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host ""
Write-Host "🧹 Limpando tokens..." -ForegroundColor Yellow
foreach ($tokenDir in $tokensToClean) {
    if (Test-Path $tokenDir) {
        Remove-Item -Recurse -Force $tokenDir -ErrorAction SilentlyContinue
        Write-Host "  ✅ Limpo: $tokenDir" -ForegroundColor Green
    } else {
        Write-Host "  ℹ️ Não encontrado: $tokenDir" -ForegroundColor Cyan
    }
}

Write-Host ""
Write-Host "⏳ Aguardando 5 segundos antes de continuar..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

Write-Host ""
Write-Host "✅ Pronto! Agora você pode:" -ForegroundColor Green
Write-Host ""
Write-Host "1. Atualizar o Baileys (recomendado):" -ForegroundColor Cyan
Write-Host "   npm update @whiskeysockets/baileys" -ForegroundColor White
Write-Host ""
Write-Host "2. Reiniciar o bot:" -ForegroundColor Cyan
if ($opcao -eq "1") {
    Write-Host "   npm run start:bot1" -ForegroundColor White
} elseif ($opcao -eq "2") {
    Write-Host "   npm run start:bot2" -ForegroundColor White
} elseif ($opcao -eq "3") {
    Write-Host "   npm run start:bot3" -ForegroundColor White
} else {
    Write-Host "   npm run start:bot1  (em terminal 1)" -ForegroundColor White
    Write-Host "   npm run start:bot2  (em terminal 2)" -ForegroundColor White
    Write-Host "   npm run start:bot3  (em terminal 3)" -ForegroundColor White
}
Write-Host ""
Write-Host "💡 Dica: Se o erro persistir, aguarde 10-15 minutos antes de tentar novamente." -ForegroundColor Yellow
Write-Host "   O WhatsApp pode ter bloqueado temporariamente sua conexão." -ForegroundColor Yellow

