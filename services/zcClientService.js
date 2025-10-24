const zcAuthService = require('./zcAuthService');

class ZcClientService {
    /**
     * Busca cliente por CPF usando parâmetro 'pesquisa'
     * @param {string} cpf - CPF do cliente (apenas números)
     * @returns {Promise<object>} Dados do cliente
     */
    async getClientByCpf(cpf) {
        try {
            
            // Remove formatação do CPF (pontos, traços, espaços)
            const cleanCpf = cpf.replace(/\D/g, '');
            
            if (cleanCpf.length !== 11) {
                throw new Error('CPF deve ter 11 dígitos');
            }

            // Tenta diferentes formatos do CPF
            const searchVariations = [
                cleanCpf,                    // Formato original
                cleanCpf.padStart(11, '0'),  // Adiciona zeros à esquerda
                cleanCpf.replace(/^0+/, '')  // Remove zeros à esquerda
            ];
            
            for (const variation of searchVariations) {
                
                // Primeira tentativa: usando parâmetro 'pesquisa'
                const response = await zcAuthService.makeAuthenticatedRequest(
                    'GET',
                    `/clientes?pesquisa=${variation}`
                );

                if (response && response.data && response.data.length > 0) {
                    // Procura por correspondência exata ou parcial
                    const client = response.data.find(c => {
                        const clientDoc = c.documento.toString();
                        return clientDoc === variation || 
                               clientDoc === cleanCpf || 
                               clientDoc === cleanCpf.padStart(11, '0') ||
                               clientDoc === cleanCpf.replace(/^0+/, '');
                    });
                    
                    if (client) {
                        return client;
                    }
                }
            }

            // Se não encontrou com pesquisa, tenta outros métodos
            for (const variation of searchVariations) {
                
                const response2 = await zcAuthService.makeAuthenticatedRequest(
                    'GET',
                    `/clientes?cpf=${variation}&pesquisaAvancada=true`
                );

                if (response2 && response2.data && response2.data.length > 0) {
                    const client = response2.data[0];
                    return client;
                }
            }

            throw new Error('Cliente não encontrado com nenhum método de busca');

        } catch (error) {
            console.error('❌ Erro ao buscar cliente:', error.message);
            throw error;
        }
    }

    /**
     * Busca cliente por documento (CPF/CNPJ)
     * @param {string} documento - Documento do cliente
     * @returns {Promise<object>} Dados do cliente
     */
    async getClientByDocument(documento) {
        try {
            
            // Remove formatação do documento
            const cleanDoc = documento.replace(/\D/g, '');
            
            if (cleanDoc.length < 8) {
                throw new Error('Documento deve ter pelo menos 8 dígitos');
            }

            // Tenta diferentes formatos do documento
            const searchVariations = [
                cleanDoc,                    // Formato original
                cleanDoc.padStart(11, '0'),  // Adiciona zeros à esquerda para CPF
                cleanDoc.replace(/^0+/, '')  // Remove zeros à esquerda
            ];
            
            for (const variation of searchVariations) {
                const response = await zcAuthService.makeAuthenticatedRequest(
                    'GET',
                    `/clientes?pesquisa=${variation}`
                );
                
                if (response && response.data && response.data.length > 0) {
                    // Procura por correspondência exata ou parcial
                    const client = response.data.find(c => {
                        const clientDoc = c.documento.toString();
                        return clientDoc === variation || 
                               clientDoc === cleanDoc || 
                               clientDoc === cleanDoc.padStart(11, '0') ||
                               clientDoc === cleanDoc.replace(/^0+/, '');
                    });
                    
                    if (client) {
                        // console.log('\n🎯 ===== CLIENTE ENCONTRADO POR DOCUMENTO =====');
                        // console.log(`📋 ID: ${client.id}`);
                        // console.log(`👤 Nome: ${client.nome || 'Não informado'}`);
                        // console.log(`🆔 Documento: ${client.documento || 'Não informado'}`);
                        // console.log(`👤 Tipo Pessoa: ${client.tipoPessoa || 'Não informado'}`);
                        // console.log(`🏷️ Apelido: ${client.apelido || 'Não informado'}`);
                        // console.log(`📧 Email: ${client.email || 'Não informado'}`);
                        // console.log(`📱 Telefone: ${client.telefone || 'Não informado'}`);
                        // console.log(`📱 Celular: ${client.celular || 'Não informado'}`);
                        // console.log(`📧 Email 2: ${client.email2 || 'Não informado'}`);
                        // console.log(`📧 Email Aniversário: ${client.emailAniversario ? 'Ativo' : 'Inativo'}`);
                        // console.log(`📧 Email Cobrança: ${client.emailCobranca ? 'Ativo' : 'Inativo'}`);
                        // console.log(`📧 Email Outros: ${client.emailOutros ? 'Ativo' : 'Inativo'}`);
                        // console.log(`🏠 Endereço Principal: ${client.endereco || 'Não informado'}`);
                        // console.log(`🏘️ Bairro: ${client.enderecoBairro || 'Não informado'}`);
                        // console.log(`🏙️ Cidade: ${client.cidade || 'Não informado'}`);
                        // console.log(`🗺️ Estado (UF): ${client.uf || 'Não informado'}`);
                        // console.log(`📮 CEP: ${client.cep || 'Não informado'}`);
                        // console.log(`🌍 País: ${client.pais || 'Não informado'}`);
                        // console.log(`🏠 Complemento: ${client.enderecoComplemento || 'Não informado'}`);
                        // console.log(`🏠 Número: ${client.enderecoNumero || 'Não informado'}`);
                        // console.log(`🏠 Referência: ${client.enderecoReferencia || 'Não informado'}`);
                        // console.log(`🏠 Localidade: ${client.localidade || 'Não informado'}`);
                        // console.log(`🏠 Cidade IBGE: ${client.cidadeIbge || 'Não informado'}`);
                        // console.log(`📍 Coordenadas GPS: ${client.coordenadasGps || 'Não informado'}`);
                        // console.log(`📍 Coordenadas Cobrança: ${client.cobrancaCoordenadasGps || 'Não informado'}`);
                        // console.log(`🏠 Endereço Cobrança: ${client.cobrancaEndereco || 'Não informado'}`);
                        // console.log(`🏘️ Bairro Cobrança: ${client.cobrancaEnderecoBairro || 'Não informado'}`);
                        // console.log(`🏙️ Cidade Cobrança: ${client.cobrancaCidade || 'Não informado'}`);
                        // console.log(`🗺️ Estado Cobrança: ${client.cobrancaUf || 'Não informado'}`);
                        // console.log(`📮 CEP Cobrança: ${client.cobrancaCep || 'Não informado'}`);
                        // console.log(`🌍 País Cobrança: ${client.cobrancaPais || 'Não informado'}`);
                        // console.log(`🏠 Complemento Cobrança: ${client.cobrancaEnderecoComplemento || 'Não informado'}`);
                        // console.log(`🏠 Número Cobrança: ${client.cobrancaEnderecoNumero || 'Não informado'}`);
                        // console.log(`🏠 Referência Cobrança: ${client.cobrancaEnderecoReferencia || 'Não informado'}`);
                        // console.log(`🏠 Localidade Cobrança: ${client.cobrancaLocalidade || 'Não informado'}`);
                        // console.log(`🏠 Cidade IBGE Cobrança: ${client.cobrancaCidadeIbge || 'Não informado'}`);
                        // console.log(`🔄 Endereço Igual: ${client.cobrancaIgual ? 'Sim' : 'Não'}`);
                        // console.log(`📝 Observações: ${client.observacoes || 'Não informado'}`);
                        // console.log(`📅 Data Cadastro: ${client.dataCadastro || 'Não informado'}`);
                        // console.log(`📅 Data Alteração: ${client.dataAlteracao || 'Não informado'}`);
                        // console.log(`📅 Data Nascimento: ${client.dataNascimento || 'Não informado'}`);
                        // console.log(`👤 Sexo: ${client.sexo || 'Não informado'}`);
                        // console.log(`🆔 RG: ${client.rg || 'Não informado'}`);
                        // console.log(`🏢 CNPJ: ${client.cnpj || 'Não informado'}`);
                        // console.log(`🏢 Inscrição Estadual: ${client.inscricaoEstadual || 'Não informado'}`);
                        // console.log(`🏢 Inscrição Municipal: ${client.inscricaoMunicipal || 'Não informado'}`);
                        // console.log(`🏢 Nome Fantasia: ${client.nomeFantasia || 'Não informado'}`);
                        // console.log(`🏢 RUC: ${client.ruc || 'Não informado'}`);
                        // console.log(`🌍 Documento Exterior: ${client.documentoExterior || 'Não informado'}`);
                        // console.log(`🌍 Exterior: ${client.exterior ? 'Sim' : 'Não'}`);
                        // console.log(`🏢 Profissão: ${client.profissao || 'Não informado'}`);
                        // console.log(`👨‍👩‍👧‍👦 Nome da Mãe: ${client.nomeMae || 'Não informado'}`);
                        // console.log(`👨‍👩‍👧‍👦 Nome do Pai: ${client.nomePai || 'Não informado'}`);
                        // console.log(`🏢 Local Trabalho: ${client.localTrabalho || 'Não informado'}`);
                        // console.log(`✅ Status: ${client.status || 'Não informado'}`);
                        // console.log(`🚫 Documento Bloqueado: ${client.documentoBloqueado ? 'Sim' : 'Não'}`);
                        // console.log(`🚫 Data Bloqueio: ${client.documentoBloqueadoDataHora || 'Não informado'}`);
                        // console.log(`🚫 Obs Bloqueio: ${client.documentoBloqueadoObservacao || 'Não informado'}`);
                        // console.log(`🚫 Endereço Bloqueado: ${client.enderecoBloqueado ? 'Sim' : 'Não'}`);
                        // console.log(`👤 Estado Civil: ${client.estadoCivil || 'Não informado'}`);
                        // console.log(`🌾 Produtor Rural: ${client.produtorRural ? 'Sim' : 'Não'}`);
                        // console.log(`🏢 Optante Simples Nacional: ${client.optanteSimplesNacional ? 'Sim' : 'Não'}`);
                        // console.log(`👤 Responsável: ${client.responsavel || 'Não informado'}`);
                        // console.log('='.repeat(50));
                        return client;
                    }
                }
            }

            throw new Error('Cliente não encontrado com este documento');

        } catch (error) {
            console.error('❌ Erro ao buscar cliente por documento:', error.message);
            throw error;
        }
    }

    /**
     * Busca cliente por nome usando parâmetro 'pesquisa'
     * @param {string} nome - Nome do cliente
     * @returns {Promise<Array>} Lista de clientes encontrados
     */
    async getClientsByName(nome) {
        try {
            // console.log(`🔍 Buscando clientes com nome: ${nome}`);
            
            const response = await zcAuthService.makeAuthenticatedRequest(
                'GET',
                `/clientes?pesquisa=${encodeURIComponent(nome)}`
            );

            if (response && response.data && response.data.length > 0) {
                // console.log(`✅ ${response.data.length} cliente(s) encontrado(s) com nome "${nome}"`);
                
                // Mostra detalhes completos de cada cliente encontrado
                response.data.forEach((client, index) => {
                    // console.log(`\n🎯 ===== CLIENTE ${index + 1} ENCONTRADO POR NOME =====`);
                    // console.log(`📋 ID: ${client.id}`);
                    // console.log(`👤 Nome: ${client.nome || 'Não informado'}`);
                    // console.log(`🆔 Documento: ${client.documento || 'Não informado'}`);
                    // console.log(`👤 Tipo Pessoa: ${client.tipoPessoa || 'Não informado'}`);
                    // console.log(`🏷️ Apelido: ${client.apelido || 'Não informado'}`);
                    // console.log(`📧 Email: ${client.email || 'Não informado'}`);
                    // console.log(`📱 Telefone: ${client.telefone || 'Não informado'}`);
                    // console.log(`📱 Celular: ${client.celular || 'Não informado'}`);
                    // console.log(`🏠 Endereço: ${client.endereco || 'Não informado'}`);
                    // console.log(`🏘️ Bairro: ${client.bairro || 'Não informado'}`);
                    // console.log(`🏙️ Cidade: ${client.cidade || 'Não informado'}`);
                    // console.log(`🗺️ Estado: ${client.estado || 'Não informado'}`);
                    // console.log(`📮 CEP: ${client.cep || 'Não informado'}`);
                    // console.log(`🌍 País: ${client.pais || 'Não informado'}`);
                    // console.log(`📍 Coordenadas GPS: ${client.coordenadasGps || 'Não informado'}`);
                    // console.log(`📍 Coordenadas Cobrança: ${client.cobrancaCoordenadasGps || 'Não informado'}`);
                    // console.log(`📝 Observações: ${client.observacoes || 'Não informado'}`);
                    // console.log(`📅 Data Cadastro: ${client.dataCadastro || 'Não informado'}`);
                    // console.log(`📅 Data Atualização: ${client.dataAtualizacao || 'Não informado'}`);
                    // console.log(`✅ Status: ${client.status || 'Não informado'}`);
                    // console.log('='.repeat(50));
                });
                
                return response.data;
            } else {
                // console.log(`❌ Nenhum cliente encontrado com nome "${nome}"`);
                return [];
            }

        } catch (error) {
            console.error('❌ Erro ao buscar cliente por nome:', error.message);
            throw error;
        }
    }

    /**
     * Obtém detalhes completos de um cliente
     * @param {string} clientId - ID do cliente
     * @returns {Promise<object>} Detalhes do cliente
     */
    async getClientDetails(clientId) {
        try {
            // console.log(`🔍 Obtendo detalhes do cliente ID: ${clientId}`);
            
            const response = await zcAuthService.makeAuthenticatedRequest(
                'GET',
                `/clientes/${clientId}`
            );

            // console.log(`✅ Detalhes do cliente obtidos com sucesso`);
            
            // Mostra todos os detalhes do cliente
            if (response && response.data) {
                const client = response.data;
                // console.log('\n🎯 ===== DETALHES COMPLETOS DO CLIENTE =====');
                // console.log(`📋 ID: ${client.id}`);
                // console.log(`👤 Nome: ${client.nome || 'Não informado'}`);
                // console.log(`🆔 Documento: ${client.documento || 'Não informado'}`);
                // console.log(`👤 Tipo Pessoa: ${client.tipoPessoa || 'Não informado'}`);
                // console.log(`🏷️ Apelido: ${client.apelido || 'Não informado'}`);
                // console.log(`📧 Email: ${client.email || 'Não informado'}`);
                // console.log(`📧 Email 2: ${client.email2 || 'Não informado'}`);
                // console.log(`📧 Email Aniversário: ${client.emailAniversario ? 'Ativo' : 'Inativo'}`);
                // console.log(`📧 Email Cobrança: ${client.emailCobranca ? 'Ativo' : 'Inativo'}`);
                // console.log(`📧 Email Outros: ${client.emailOutros ? 'Ativo' : 'Inativo'}`);
                // console.log(`📱 Telefone: ${client.telefone || 'Não informado'}`);
                // console.log(`📱 Celular: ${client.celular || 'Não informado'}`);
                // console.log(`🏠 Endereço Principal: ${client.endereco || 'Não informado'}`);
                // console.log(`🏘️ Bairro: ${client.enderecoBairro || 'Não informado'}`);
                // console.log(`🏙️ Cidade: ${client.cidade || 'Não informado'}`);
                // console.log(`🗺️ Estado (UF): ${client.uf || 'Não informado'}`);
                // console.log(`📮 CEP: ${client.cep || 'Não informado'}`);
                // console.log(`🌍 País: ${client.pais || 'Não informado'}`);
                // console.log(`🏠 Complemento: ${client.enderecoComplemento || 'Não informado'}`);
                // console.log(`🏠 Número: ${client.enderecoNumero || 'Não informado'}`);
                // console.log(`🏠 Referência: ${client.enderecoReferencia || 'Não informado'}`);
                // console.log(`🏠 Localidade: ${client.localidade || 'Não informado'}`);
                // console.log(`🏠 Cidade IBGE: ${client.cidadeIbge || 'Não informado'}`);
                // console.log(`📍 Coordenadas GPS: ${client.coordenadasGps || 'Não informado'}`);
                // console.log(`📍 Coordenadas Cobrança: ${client.cobrancaCoordenadasGps || 'Não informado'}`);
                // console.log(`🏠 Endereço Cobrança: ${client.cobrancaEndereco || 'Não informado'}`);
                // console.log(`🏘️ Bairro Cobrança: ${client.cobrancaEnderecoBairro || 'Não informado'}`);
                // console.log(`🏙️ Cidade Cobrança: ${client.cobrancaCidade || 'Não informado'}`);
                // console.log(`🗺️ Estado Cobrança: ${client.cobrancaUf || 'Não informado'}`);
                // console.log(`📮 CEP Cobrança: ${client.cobrancaCep || 'Não informado'}`);
                // console.log(`🌍 País Cobrança: ${client.cobrancaPais || 'Não informado'}`);
                // console.log(`🏠 Complemento Cobrança: ${client.cobrancaEnderecoComplemento || 'Não informado'}`);
                // console.log(`🏠 Número Cobrança: ${client.cobrancaEnderecoNumero || 'Não informado'}`);
                // console.log(`🏠 Referência Cobrança: ${client.cobrancaEnderecoReferencia || 'Não informado'}`);
                // console.log(`🏠 Localidade Cobrança: ${client.cobrancaLocalidade || 'Não informado'}`);
                // console.log(`🏠 Cidade IBGE Cobrança: ${client.cobrancaCidadeIbge || 'Não informado'}`);
                // console.log(`🔄 Endereço Igual: ${client.cobrancaIgual ? 'Sim' : 'Não'}`);
                // console.log(`📝 Observações: ${client.observacoes || 'Não informado'}`);
                // console.log(`📅 Data Cadastro: ${client.dataCadastro || 'Não informado'}`);
                // console.log(`📅 Data Alteração: ${client.dataAlteracao || 'Não informado'}`);
                // console.log(`📅 Data Nascimento: ${client.dataNascimento || 'Não informado'}`);
                // console.log(`👤 Sexo: ${client.sexo || 'Não informado'}`);
                // console.log(`🆔 RG: ${client.rg || 'Não informado'}`);
                // console.log(`🏢 CNPJ: ${client.cnpj || 'Não informado'}`);
                // console.log(`🏢 Inscrição Estadual: ${client.inscricaoEstadual || 'Não informado'}`);
                // console.log(`🏢 Inscrição Municipal: ${client.inscricaoMunicipal || 'Não informado'}`);
                // console.log(`🏢 Nome Fantasia: ${client.nomeFantasia || 'Não informado'}`);
                // console.log(`🏢 RUC: ${client.ruc || 'Não informado'}`);
                // console.log(`🌍 Documento Exterior: ${client.documentoExterior || 'Não informado'}`);
                // console.log(`🌍 Exterior: ${client.exterior ? 'Sim' : 'Não'}`);
                // console.log(`🏢 Profissão: ${client.profissao || 'Não informado'}`);
                // console.log(`👨‍👩‍👧‍👦 Nome da Mãe: ${client.nomeMae || 'Não informado'}`);
                // console.log(`👨‍👩‍👧‍👦 Nome do Pai: ${client.nomePai || 'Não informado'}`);
                // console.log(`🏢 Local Trabalho: ${client.localTrabalho || 'Não informado'}`);
                // console.log(`✅ Status: ${client.status || 'Não informado'}`);
                // console.log(`🚫 Documento Bloqueado: ${client.documentoBloqueado ? 'Sim' : 'Não'}`);
                // console.log(`🚫 Data Bloqueio: ${client.documentoBloqueadoDataHora || 'Não informado'}`);
                // console.log(`🚫 Obs Bloqueio: ${client.documentoBloqueadoObservacao || 'Não informado'}`);
                // console.log(`🚫 Endereço Bloqueado: ${client.enderecoBloqueado ? 'Sim' : 'Não'}`);
                // console.log(`👤 Estado Civil: ${client.estadoCivil || 'Não informado'}`);
                // console.log(`🌾 Produtor Rural: ${client.produtorRural ? 'Sim' : 'Não'}`);
                // console.log(`🏢 Optante Simples Nacional: ${client.optanteSimplesNacional ? 'Sim' : 'Não'}`);
                // console.log(`👤 Responsável: ${client.responsavel || 'Não informado'}`);
                // console.log('='.repeat(50));
            }
            
            return response;

        } catch (error) {
            console.error('❌ Erro ao obter detalhes do cliente:', error.message);
            throw error;
        }
    }

    /**
     * Lista serviços de um cliente
     * @param {string} clientId - ID do cliente
     * @returns {Promise<Array>} Lista de serviços
     */
    async getClientServices(clientId) {
        try {
            // console.log(`🔍 Obtendo serviços do cliente ID: ${clientId}`);
            
            const response = await zcAuthService.makeAuthenticatedRequest(
                'GET',
                `/clientes/${clientId}/servicos`
            );

            // Verifica se a resposta tem a estrutura correta
            if (response && response.data && Array.isArray(response.data)) {
                // console.log(`✅ ${response.data.length} serviços encontrados para o cliente`);
                return response.data;
            } else if (Array.isArray(response)) {
                // console.log(`✅ ${response.length} serviços encontrados para o cliente`);
                return response;
            } else {
                // console.log('⚠️ Resposta da API não é um array válido');
                // console.log('📋 Conteúdo da resposta:', JSON.stringify(response, null, 2));
                return [];
            }

        } catch (error) {
            console.error('❌ Erro ao obter serviços do cliente:', error.message);
            throw error;
        }
    }

    /**
     * Obtém detalhes de um serviço específico
     * @param {string} clientId - ID do cliente
     * @param {string} serviceId - ID do serviço
     * @returns {Promise<object>} Detalhes do serviço
     */
    async getServiceDetails(clientId, serviceId) {
        try {
            // console.log(`🔍 Obtendo detalhes do serviço ID: ${serviceId}`);
            
            const response = await zcAuthService.makeAuthenticatedRequest(
                'GET',
                `/clientes/${clientId}/servicos/${serviceId}`
            );

            // console.log(`✅ Detalhes do serviço obtidos com sucesso`);
            return response;

        } catch (error) {
            console.error('❌ Erro ao obter detalhes do serviço:', error.message);
            throw error;
        }
    }

    /**
     * Lista todos os clientes
     * @param {number} limit - Limite de clientes (padrão: 100)
     * @param {number} page - Página para paginação (padrão: 1)
     * @returns {Promise<Array>} Lista de clientes
     */
    async getAllClients(limit = 100, page = 1) {
        try {
            // console.log(`🔍 Listando clientes (página: ${page}, limite: ${limit})`);
            
            const response = await zcAuthService.makeAuthenticatedRequest(
                'GET',
                `/clientes?limit=100&page=${page}`
            );

            // Verifica se a resposta tem a estrutura data
            if (response && response.data && Array.isArray(response.data)) {
                // console.log(`✅ ${response.data.length} clientes encontrados na página ${page}`);
                // console.log('📋 Lista de todos os clientes:');
                response.data.forEach((client, index) => {
                    // console.log(`${index + 1}. ID: ${client.id} | Nome: ${client.nome || 'N/A'} | CPF: ${client.documento || 'N/A'} | Tipo: ${client.tipoPessoa || 'N/A'}`);
                });
                
                // Mostra detalhes completos de cada cliente
                // console.log('\n📋 ===== DETALHES COMPLETOS DOS CLIENTES =====');
                response.data.forEach((client, index) => {
                    // console.log(`\n👤 Cliente ${index + 1}:`);
                    // console.log(`   📋 ID: ${client.id}`);
                    // console.log(`   👤 Nome: ${client.nome || 'Não informado'}`);
                    // console.log(`   🆔 CPF: ${client.documento || 'Não informado'}`);
                    // console.log(`   👤 Tipo Pessoa: ${client.tipoPessoa || 'Não informado'}`);
                    // console.log(`   🏷️ Apelido: ${client.apelido || 'Não informado'}`);
                    // console.log('   ' + '─'.repeat(50));
                });
                
                return response.data;
            } else {
                // console.log('⚠️ Resposta da API não é um array válido');
                // console.log('📋 Tipo da resposta:', typeof response);
                return [];
            }

        } catch (error) {
            console.error('❌ Erro ao listar clientes:', error.message);
            throw error;
        }
    }

    /**
     * Lista todos os clientes com informações detalhadas no console
     * @param {number} limit - Limite de clientes por página (padrão: 100)
     */
    async listAllClientsInConsole(limit = 100) {
        try {
            
            const clients = await this.getAllClients(limit, 1);
            
            if (clients.length === 0) {
                return;
            }

            // Lista clientes silenciosamente
            clients.forEach((client, index) => {
                // Log removido para limpeza
            });


        } catch (error) {
            console.error('❌ Erro ao listar clientes no console:', error.message);
        }
    }

    /**
     * Busca cliente e seus serviços por CPF
     * @param {string} cpf - CPF do cliente
     * @returns {Promise<object>} Cliente com seus serviços
     */
    async getClientWithServices(cpf) {
        try {
            // Busca o cliente
            const client = await this.getClientByCpf(cpf);
            
            // Busca os serviços do cliente
            const services = await this.getClientServices(client.id);
            
            return {
                ...client,
                services: services
            };

        } catch (error) {
            console.error('❌ Erro ao buscar cliente com serviços:', error.message);
            throw error;
        }
    }
}

module.exports = new ZcClientService();
