module.exports = {
  apps: [
    {
      name: 'bot1',
      script: 'index.js',
      interpreter: 'node',
      // Aumenta heap para evitar estouro de memória (4GB)
      node_args: '--max-old-space-size=4096 --max-snapshots=1',
      // Variáveis de ambiente
      env: {
        WHATSAPP_PROVIDER: 'baileys',
        PORT: '3009',
        BAILEYS_SESSION_ID: 'bot1',
        BAILEYS_LOG_LEVEL: 'silent', // Desativa logs do Baileys completamente
        NODE_ENV: 'production'
      },
      // Configurações de log
      error_file: './logs/bot1-error.log',
      out_file: './logs/bot1-out.log',
      log_file: './logs/bot1-combined.log',
      time: true,
      // Limita tamanho dos logs (10MB)
      max_size: '10M',
      // Mantém apenas 3 arquivos de log
      retain: 3,
      // Comprime logs antigos
      compress: true,
      // Auto-restart em caso de crash
      autorestart: true,
      // Máximo de restarts em 10 segundos
      max_restarts: 10,
      min_uptime: '10s',
      // Watch desabilitado em produção
      watch: false,
      // Instâncias
      instances: 1,
      exec_mode: 'fork'
    },
    {
      name: 'bot2',
      script: 'index.js',
      interpreter: 'node',
      node_args: '--max-old-space-size=4096 --max-snapshots=1',
      env: {
        WHATSAPP_PROVIDER: 'baileys',
        PORT: '3010',
        BAILEYS_SESSION_ID: 'bot2',
        BAILEYS_LOG_LEVEL: 'silent',
        NODE_ENV: 'production'
      },
      error_file: './logs/bot2-error.log',
      out_file: './logs/bot2-out.log',
      log_file: './logs/bot2-combined.log',
      time: true,
      max_size: '10M',
      retain: 3,
      compress: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    },
    {
      name: 'bot3',
      script: 'index.js',
      interpreter: 'node',
      node_args: '--max-old-space-size=4096 --max-snapshots=1',
      env: {
        WHATSAPP_PROVIDER: 'baileys',
        PORT: '3011',
        BAILEYS_SESSION_ID: 'bot3',
        BAILEYS_LOG_LEVEL: 'silent',
        NODE_ENV: 'production'
      },
      error_file: './logs/bot3-error.log',
      out_file: './logs/bot3-out.log',
      log_file: './logs/bot3-combined.log',
      time: true,
      max_size: '10M',
      retain: 3,
      compress: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
};
