# Script para parar todos os bots Node
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "PARANDO TODOS OS BOTS" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Lista processos Node relacionados ao bot
Write-Host "Processos Node encontrados:" -ForegroundColor Green
$botProcesses = Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
    $proc = $_;
    try {
        $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.Id)").CommandLine;
        if ($cmd) {
            # Verifica se é processo do bot (contém index.js, botZcnet, ou cross-env com baileys)
            return ($cmd -like "*index.js*" -or 
                    $cmd -like "*botZcnet*" -or 
                    ($cmd -like "*cross-env*" -and $cmd -like "*baileys*") -or
                    ($cmd -like "*node*" -and $cmd -like "*index.js*"));
        }
        return $false;
    } catch {
        return $false;
    }
}

if ($botProcesses) {
    Write-Host ""
    $botProcesses | Format-Table Id, ProcessName, StartTime -AutoSize
    Write-Host ""
    
    $count = 0;
    foreach ($proc in $botProcesses) {
        try {
            Write-Host "Parando processo PID: $($proc.Id)..." -ForegroundColor Yellow
            Stop-Process -Id $proc.Id -Force -ErrorAction Stop
            $count++
            Write-Host "  OK - Processo $($proc.Id) parado" -ForegroundColor Green
        } catch {
            Write-Host "  ERRO - Nao foi possivel parar processo $($proc.Id): $($_.Exception.Message)" -ForegroundColor Red
        }
    }
    
    Write-Host ""
    Write-Host "Total de processos parados: $count" -ForegroundColor Cyan
} else {
    Write-Host "Nenhum processo de bot encontrado." -ForegroundColor Gray
}

Write-Host ""
Write-Host "Aguardando 3 segundos..." -ForegroundColor Gray
Start-Sleep -Seconds 3

Write-Host ""
Write-Host "Verificando processos restantes:" -ForegroundColor Green
$remaining = Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
    $proc = $_;
    try {
        $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.Id)").CommandLine;
        if ($cmd) {
            return ($cmd -like "*index.js*" -or 
                    $cmd -like "*botZcnet*" -or 
                    ($cmd -like "*cross-env*" -and $cmd -like "*baileys*"));
        }
        return $false;
    } catch {
        return $false;
    }
}

if ($remaining) {
    Write-Host "ATENCAO: Ainda ha processos rodando:" -ForegroundColor Red
    $remaining | Format-Table Id, ProcessName -AutoSize
    Write-Host ""
    Write-Host "Tente parar manualmente com:" -ForegroundColor Yellow
    Write-Host "  Stop-Process -Id <PID> -Force" -ForegroundColor White
} else {
    Write-Host "Todos os bots foram parados com sucesso!" -ForegroundColor Green
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Aguarde 5-10 minutos antes de reiniciar" -ForegroundColor Yellow
Write-Host "para evitar rate limiting do WhatsApp" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Cyan
