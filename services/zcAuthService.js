const axios = require('axios');
const config = require('../config');

class ZcAuthService {
    constructor() {
        this.baseURL = config.zc.baseUrl;
        this.clientId = config.zc.clientId;
        this.clientSecret = config.zc.clientSecret;
        this.scope = config.zc.scope;
        this.xRequestId = config.zc.xRequestId;
        this.token = null;
        this.tokenExpiry = null;
    }

    /**
     * Autentica e obtém token de acesso
     * @returns {Promise<string>} Token de acesso
     */
    async authenticate() {
        try {
            // console.log('🔐 Iniciando autenticação...');
            
            const authData = {
                grant_type: 'client_credentials',
                client_id: this.clientId,
                client_secret: this.clientSecret,
                scope: this.scope
            };

            const response = await axios.post(`${this.baseURL}/auth/token/ispbox`, authData, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Request-ID': this.xRequestId
                },
                timeout: 15000 // 15 segundos de timeout
            });
            
            if (response.data && response.data.access_token) {
                this.token = response.data.access_token;
                this.tokenExpiry = new Date(Date.now() + (response.data.expires_in || 3600) * 1000);
                // console.log('✅ Autenticação realizada com sucesso');
                return this.token;
            } else {
                throw new Error('Token não encontrado na resposta de autenticação');
            }

        } catch (error) {
            console.error('❌ Erro na autenticação:', error.message);
            if (error.response) {
                console.error('📋 Detalhes do erro de autenticação:', error.response.data);
            }
            throw error;
        }
    }

    /**
     * Verifica se o token está válido
     * @returns {boolean} True se o token está válido
     */
    isTokenValid() {
        if (!this.token || !this.tokenExpiry) {
            return false;
        }
        return new Date() < this.tokenExpiry;
    }

    /**
     * Obtém token válido (autentica se necessário)
     * @returns {Promise<string>} Token válido
     */
    async getValidToken() {
        if (!this.isTokenValid()) {
            await this.authenticate();
        }
        return this.token;
    }

    /**
     * Faz uma requisição autenticada
     * @param {string} method - Método HTTP (GET, POST, PUT, DELETE)
     * @param {string} endpoint - Endpoint da API
     * @param {object} data - Dados para envio (opcional)
     * @returns {Promise<object>} Resposta da API
     */
    async makeAuthenticatedRequest(method, endpoint, data = null) {
        try {
            const token = await this.getValidToken();
            
            const requestConfig = {
                method: method.toLowerCase(),
                url: `${this.baseURL}${endpoint}`,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'X-Request-ID': this.xRequestId
                },
                timeout: 30000 // 30 segundos de timeout para requisições
            };

            if (data) {
                requestConfig.data = data;
            }

            // console.log(`🌐 Fazendo requisição ${method.toUpperCase()} para: ${endpoint}`);
            
            const response = await axios(requestConfig);
            
            // console.log(`✅ Requisição realizada com sucesso (Status: ${response.status})`);
            return response.data;

        } catch (error) {
            // Tratamento melhorado de erros
            if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                console.error(`⏱️ Timeout na requisição ${method.toUpperCase()} ${endpoint}`);
                throw new Error('Timeout: API não respondeu a tempo');
            }
            
            console.error(`❌ Erro na requisição ${method.toUpperCase()} ${endpoint}:`, error.message);
            
            if (error.response) {
                console.error('📋 Detalhes do erro:', {
                    status: error.response.status,
                    statusText: error.response.statusText,
                    data: error.response.data
                });
            }
            
            throw error;
        }
    }

    /**
     * Testa a conexão com a API
     * @returns {Promise<boolean>} True se a conexão está funcionando
     */
    async testConnection() {
        try {
            // console.log('🔍 Testando conexão com a API...');
            
            const response = await this.makeAuthenticatedRequest('GET', '/health');
            
            // console.log('✅ Conexão com a API funcionando');
            return true;

        } catch (error) {
            console.error('❌ Erro na conexão com a API:', error.message);
            return false;
        }
    }
}

module.exports = new ZcAuthService();
