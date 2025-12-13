# Script PowerShell para limpar arquivos de documentação desnecessários
# Mantém apenas README.md e PRODUCTION.md

Write-Host "🧹 Limpando arquivos de documentação desnecessários..." -ForegroundColor Yellow

# Lista de arquivos para manter
$keepFiles = @("README.md", "PRODUCTION.md")

# Conta arquivos .md antes
$countBefore = (Get-ChildItem -Path . -Filter "*.md" -File | Measure-Object).Count

# Remove arquivos .md exceto os que devem ser mantidos
Get-ChildItem -Path . -Filter "*.md" -File | ForEach-Object {
    if ($keepFiles -contains $_.Name) {
        Write-Host "  Mantendo: $($_.Name)" -ForegroundColor Green
    } else {
        Write-Host "  Removendo: $($_.Name)" -ForegroundColor Red
        Remove-Item $_.FullName -Force
    }
}

# Conta arquivos .md depois
$countAfter = (Get-ChildItem -Path . -Filter "*.md" -File | Measure-Object).Count

Write-Host ""
Write-Host "✅ Limpeza concluída!" -ForegroundColor Green
Write-Host "   Antes: $countBefore arquivos .md"
Write-Host "   Depois: $countAfter arquivos .md"
Write-Host "   Removidos: $($countBefore - $countAfter) arquivos"



