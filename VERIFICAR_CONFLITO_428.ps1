# Script para verificar e resolver conflito 428
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "VERIFICANDO CONFLITO DE SESSAO (428)" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 1. Lista todos os processos Node
Write-Host "Processos Node rodando:" -ForegroundColor Green
Get-Process -Name node -ErrorAction SilentlyContinue | Format-Table Id, ProcessName, StartTime -AutoSize

Write-Host ""

# 2. Verifica portas em uso
Write-Host "Portas em uso:" -ForegroundColor Green
$ports = @(3009, 3010, 3011)
foreach ($port in $ports) {
    $connection = netstat -ano | Select-String ":$port" | Select-Object -First 1
    if ($connection) {
        $pid = ($connection -split '\s+')[-1]
        Write-Host "   Porta $port : PID $pid" -ForegroundColor Yellow
    } else {
        Write-Host "   Porta $port : Livre" -ForegroundColor Gray
    }
}

Write-Host ""

# 3. Lista diretorios de tokens
Write-Host "Diretorios de tokens encontrados:" -ForegroundColor Green
$tokenDirs = Get-ChildItem -Path . -Directory -Filter "tokens-*" -ErrorAction SilentlyContinue
if ($tokenDirs) {
    foreach ($dir in $tokenDirs) {
        Write-Host "   $($dir.Name)" -ForegroundColor Yellow
    }
} else {
    Write-Host "   Nenhum diretorio de tokens encontrado" -ForegroundColor Gray
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "SOLUCAO PARA ERRO 428:" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "O erro 428 significa que ha OUTRO bot usando o mesmo numero!" -ForegroundColor Red
Write-Host ""
Write-Host "OPCOES:" -ForegroundColor Yellow
Write-Host ""
Write-Host "1. PARAR TODOS OS BOTS LOCALMENTE:" -ForegroundColor Cyan
Write-Host "   .\PARAR_TODOS_BOTS.ps1" -ForegroundColor White
Write-Host ""
Write-Host "2. VERIFICAR SE HA BOT NA VPS:" -ForegroundColor Cyan
Write-Host "   - Acesse sua VPS" -ForegroundColor White
Write-Host "   - Pare o bot que esta rodando la" -ForegroundColor White
Write-Host "   - Aguarde 5 minutos" -ForegroundColor White
Write-Host "   - Tente conectar localmente novamente" -ForegroundColor White
Write-Host ""
Write-Host "3. USAR NUMEROS DIFERENTES:" -ForegroundColor Cyan
Write-Host "   - Cada bot deve usar um numero de WhatsApp diferente" -ForegroundColor White
Write-Host "   - Nao pode ter 2 bots com o mesmo numero!" -ForegroundColor Red
Write-Host ""
Write-Host "4. VERIFICAR SE HA MULTIPLAS INSTANCIAS:" -ForegroundColor Cyan
Write-Host "   - Certifique-se de que cada bot usa:" -ForegroundColor White
Write-Host "     * Diretorio diferente (tokens-bot1, tokens-bot2, etc)" -ForegroundColor White
Write-Host "     * Porta diferente (3009, 3010, 3011)" -ForegroundColor White
Write-Host "     * Numero de WhatsApp diferente" -ForegroundColor White
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
