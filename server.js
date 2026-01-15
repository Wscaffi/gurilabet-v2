// --- ROTA COM ESPIÃO DE API (DEBUG) ---
app.get('/api/jogos', async (req, res) => {
    const dataFiltro = req.query.data || new Date().toISOString().split('T')[0];
    
    try {
        console.log(`🔍 BUSCANDO JOGOS REAIS PARA: ${dataFiltro}`);
        
        if (!process.env.API_FOOTBALL_KEY) throw new Error("CHAVE NÃO CONFIGURADA NO RAILWAY");

        const headers = { 
            'x-rapidapi-key': process.env.API_FOOTBALL_KEY.trim(), // O .trim() remove espaços acidentais
            'x-rapidapi-host': 'v3.football.api-sports.io'
        };
        
        const isAoVivo = req.query.aovivo === 'true';
        let url = isAoVivo 
            ? `https://v3.football.api-sports.io/fixtures?live=all`
            : `https://v3.football.api-sports.io/fixtures?date=${dataFiltro}`;

        const resp = await axios.get(url, { headers, timeout: 10000 });
        
        // --- O ESPIÃO ESTÁ AQUI ---
        // Isso vai imprimir no LOG do Railway a resposta exata da API
        console.log("BSB STATUS:", resp.status);
        console.log("RESPOSTA COMPLETA API:", JSON.stringify(resp.data)); 
        // --------------------------

        // Verifica erros da conta (Limite ou Bloqueio)
        if (resp.data.errors && Object.keys(resp.data.errors).length > 0) {
            console.error("❌ A API RECUSOU O PEDIDO:", resp.data.errors);
            throw new Error("Conta da API Bloqueada ou Limitada");
        }

        let fixtures = resp.data.response;
        
        // Se a lista vier vazia
        if (!fixtures || fixtures.length === 0) {
            console.error(`❌ A API FUNCIONOU, MAS RETORNOU 0 JOGOS.`); 
            console.error("MOTIVO PROVÁVEL: As ligas de hoje não estão no seu Plano Grátis.");
            throw new Error("Lista Vazia (Plano Grátis não cobre jogos de hoje)");
        }

        const jogosReais = formatar(fixtures);
        
        if (jogosReais.length === 0) {
            console.error("❌ JOGOS FORAM ENCONTRADOS, MAS FILTRADOS (JÁ ACABARAM?).");
            throw new Error("Jogos filtrados");
        }

        console.log(`✅ SUCESSO! ${jogosReais.length} jogos carregados.`);
        res.json(jogosReais);

    } catch (e) {
        console.log(`⚠️ ATIVANDO MODO DE EMERGÊNCIA: ${e.message}`);
        res.json(gerarJogosFalsos(dataFiltro));
    }
});
