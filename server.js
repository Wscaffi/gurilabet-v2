const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// =====================================================
// CONFIGURAÇÕES GERAIS - V79 (CORREÇÃO DE BANCO DE DADOS)
// =====================================================
const CONFIG = {
    // Se tiver no Railway, ele pega a var, senão usa a string
    API_KEY: process.env.API_FOOTBALL_KEY || "SUA_CHAVE_AQUI", 
    
    // 1.0 = Odd Igual da Bet365. 0.98 = 2% de margem pra casa.
    LUCRO_CASA: 0.98, 
    
    TEMPO_CACHE_MINUTOS: 45, 
    MIN_VALOR: 2.00,
    MAX_VALOR: 1000.00,
    MAX_PREMIO: 10000.00,
    
    // Limite de páginas de odds para buscar
    MAX_PAGINAS_ODDS: 5 
};

// LISTA DE "FORTES" (Só usada se a API falhar ou não tiver odd)
const TIMES_FORTES = [
    "flamengo", "palmeiras", "atletico-mg", "real madrid", "barcelona", "man city", "liverpool", "psg", "bayern", "inter", "arsenal", 
    "botafogo", "sao paulo", "corinthians", "gremio", "boca juniors", "river plate", "juventus", "milan", "vasco", "fluminense",
    "santos", "cruzeiro", "internacional", "bahia", "athletico-pr", "fortaleza", "vitoria", "sport", "ceara",
    "bragantino", "red bull", "rb bragantino", "cuiaba", "atletico-go", "juventude"
];

const TRADUCOES = { "World": "Mundo", "Brazil": "Brasil", "England": "Inglaterra", "Spain": "Espanha", "Italy": "Itália", "Germany": "Alemanha", "France": "França", "Portugal": "Portugal", "Premier League": "Premier League", "Serie A": "Série A", "La Liga": "La Liga", "Carioca - 1": "Carioca", "Paulista - A1": "Paulista A1", "Copa Libertadores": "Libertadores" };
function traduzir(txt) { return TRADUCOES[txt] || txt; }
function limparNome(nome) { return nome.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }

// CONEXÃO COM O BANCO
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// --- INICIALIZAÇÃO E CORREÇÃO AUTOMÁTICA DO BANCO ---
async function initDb() {
    try {
        // Cria tabelas se não existirem
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', detalhes JSONB, cliente TEXT, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS jogos_cache (id SERIAL PRIMARY KEY, data_ref TEXT UNIQUE, json_dados JSONB, atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        
        // --- CORREÇÃO V79: GARANTE QUE AS COLUNAS NOVAS EXISTAM ---
        // Se você usava uma versão antiga, essas colunas podiam faltar e travar o sistema
        await pool.query(`ALTER TABLE bilhetes ADD COLUMN IF NOT EXISTS cliente TEXT`);
        await pool.query(`ALTER TABLE bilhetes ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pendente'`);
        await pool.query(`ALTER TABLE bilhetes ADD COLUMN IF NOT EXISTS detalhes JSONB`);

        console.log("✅ Servidor V79 (Banco Atualizado e Pronto) Online!");
    } catch (e) { console.error("FATAL: Erro ao conectar no Banco:", e.message); }
}
initDb();

// --- ROTA DE JOGOS ---
app.get('/api/jogos', async (req, res) => {
    const dataHoje = req.query.data || new Date().toISOString().split('T')[0];
    try {
        // 1. Verifica Cache
        const cache = await pool.query("SELECT json_dados, atualizado_em FROM jogos_cache WHERE data_ref = $1", [dataHoje]);
        if (cache.rows.length > 0) {
            const diff = (new Date() - new Date(cache.rows[0].atualizado_em)) / 1000 / 60;
            if (diff < CONFIG.TEMPO_CACHE_MINUTOS) return res.json(cache.rows[0].json_dados);
        }
        
        console.log(`🌍 V79: Buscando Jogos e Odds...`);
        const headers = { 'x-apisports-key': CONFIG.API_KEY };
        
        // 2. Busca Jogos
        const respJogos = await axios.get(`https://v3.football.api-sports.io/fixtures?date=${dataHoje}&timezone=America/Sao_Paulo`, { headers });
        const listaBruta = respJogos.data.response || [];

        // 3. Busca Odds (Loop Seguro)
        let mapaOdds = {};
        try {
            let page = 1;
            let totalPages = 1;
            do {
                const r = await axios.get(`https://v3.football.api-sports.io/odds?date=${dataHoje}&bookmaker=6&timezone=America/Sao_Paulo&page=${page}`, { headers });
                if(r.data.response) r.data.response.forEach(o => { mapaOdds[o.fixture.id] = o.bookmakers[0].bets; });
                totalPages = r.data.paging.total;
                page++;
                await new Promise(resolve => setTimeout(resolve, 250)); // Delay p/ não travar
            } while (page <= totalPages && page <= CONFIG.MAX_PAGINAS_ODDS);
        } catch (e) { console.log("⚠️ API Odds limitou. Usando fallback."); }

        let jogosFinais = formatarV78(listaBruta, mapaOdds, dataHoje);
        
        if (jogosFinais.length > 0) {
            await pool.query(`INSERT INTO jogos_cache (data_ref, json_dados, atualizado_em) VALUES ($1, $2, NOW()) ON CONFLICT (data_ref) DO UPDATE SET json_dados = $2, atualizado_em = NOW()`, [dataHoje, JSON.stringify(jogosFinais)]);
        }
        res.json(jogosFinais);
    } catch (e) { 
        console.error("Erro Jogos:", e.message);
        const cacheBackup = await pool.query("SELECT json_dados FROM jogos_cache WHERE data_ref = $1", [dataHoje]);
        if(cacheBackup.rows.length > 0) return res.json(cacheBackup.rows[0].json_dados);
        res.json([]); 
    }
});

// --- ROTA FINALIZAR (AGORA MOSTRA O ERRO REAL) ---
app.post('/api/finalizar', async (req, res) => {
    try {
        let { usuario_id, valor, apostas, cliente, forcar } = req.body;
        
        // Validações básicas
        if(!apostas || !apostas.length) return res.status(400).json({erro: "Carrinho vazio"});
        if(!valor) return res.status(400).json({erro: "Valor inválido"});
        
        const dataHoje = new Date().toISOString().split('T')[0];
        const cache = await pool.query("SELECT json_dados FROM jogos_cache WHERE data_ref = $1", [dataHoje]);
        
        // Verifica mudança de odds
        if(cache.rows.length > 0 && !forcar) {
            const jogosAtuais = cache.rows[0].json_dados;
            let mudancas = [];
            for(let aposta of apostas) {
                const jogoAtual = jogosAtuais.find(j => j.id === aposta.id);
                if(jogoAtual) {
                    let oddAtual = buscarOddNoJogo(jogoAtual, aposta.opcao);
                    if(oddAtual && Math.abs(parseFloat(oddAtual) - parseFloat(aposta.odd)) > 0.10) {
                        mudancas.push({ id: aposta.id, nome: aposta.nome, opcao: aposta.opcao, oddAntiga: aposta.odd, oddNova: oddAtual });
                    }
                }
            }
            if(mudancas.length > 0) return res.json({ sucesso: false, aviso_mudanca: true, mudancas: mudancas });
        }

        let oddTotal = 1.0; 
        apostas.forEach(a => oddTotal *= parseFloat(a.odd));
        let retorno = parseFloat(valor) * oddTotal;
        
        if(retorno > CONFIG.MAX_PREMIO) retorno = CONFIG.MAX_PREMIO;
        const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
        
        // Tenta Salvar no Banco
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes, cliente, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', 
            [usuario_id||1, codigo, valor, retorno.toFixed(2), oddTotal.toFixed(2), JSON.stringify(apostas), cliente || "Anônimo", "pendente"]);
            
        res.json({sucesso: true, codigo, retorno: retorno.toFixed(2)});

    } catch (e) { 
        console.error("ERRO AO FINALIZAR:", e); // Log no terminal do Railway
        // AQUI ESTÁ A CORREÇÃO: Enviamos a mensagem real do erro para o Front
        res.status(500).json({erro: e.message || "Erro desconhecido no servidor"}); 
    }
});

function buscarOddNoJogo(jogo, opcaoNome) {
    if(opcaoNome === 'Casa') return jogo.odds.casa;
    if(opcaoNome === 'Empate') return jogo.odds.empate;
    if(opcaoNome === 'Fora') return jogo.odds.fora;
    for(let grupo of jogo.mercados) {
        for(let item of grupo.itens) {
            if(`${grupo.grupo}: ${item.nome}` === opcaoNome || item.nome === opcaoNome) return item.odd;
        }
    }
    return null;
}

// --- LÓGICA DE FORMATAÇÃO E ODDS ---
function formatarV78(listaJogos, mapaOdds, dataFiltro) {
    return listaJogos.map(j => {
        try {
            const dataLocal = j.fixture.date.substring(0, 10); 
            if (dataLocal !== dataFiltro) return null;
            const st = j.fixture.status.short;
            let statusFinal = "VS", placar = null;
            if (['FT', 'AET', 'PEN'].includes(st)) { statusFinal = "FT"; placar = { home: j.goals.home||0, away: j.goals.away||0 }; } 
            else if (['1H', '2H', 'HT', 'LIVE'].includes(st)) { statusFinal = "LIVE"; placar = { home: j.goals.home||0, away: j.goals.away||0 }; }

            let oddsFinais = null, mercadosCalculados = [];
            const betsReais = mapaOdds[j.fixture.id]; 
            
            if (statusFinal === "VS") {
                let oddsBase = null;
                if (betsReais) {
                    const m1 = betsReais.find(b => b.id === 1);
                    if (m1) oddsBase = { casa: findOdd(m1, 'Home'), empate: findOdd(m1, 'Draw'), fora: findOdd(m1, 'Away') };
                }
                if (!oddsBase) oddsBase = gerarOddInteligente(j.teams.home.name, j.teams.away.name);
                
                oddsFinais = { 
                    casa: (oddsBase.casa * CONFIG.LUCRO_CASA).toFixed(2), 
                    empate: (oddsBase.empate * CONFIG.LUCRO_CASA).toFixed(2), 
                    fora: (oddsBase.fora * CONFIG.LUCRO_CASA).toFixed(2) 
                };
                mercadosCalculados = gerarListaGarantida(oddsBase, betsReais);
            }
            
            const ligaNome = `${traduzir(j.league.country)} - ${traduzir(j.league.name)}`.toUpperCase();
            return { id: j.fixture.id, liga: ligaNome, flag: j.league.flag || "https://cdn-icons-png.flaticon.com/512/53/53280.png", home: { name: j.teams.home.name, logo: j.teams.home.logo }, away: { name: j.teams.away.name, logo: j.teams.away.logo }, data: j.fixture.date, status: statusFinal, placar: placar, odds: oddsFinais, mercados: mercadosCalculados };
        } catch (e) { return null; }
    }).filter(Boolean);
}

function findOdd(m, l) { if(!m || !m.values) return null; const o = m.values.find(v => v.value.toString() === l.toString()); return o ? parseFloat(o.odd) : null; }

function gerarOddInteligente(h, a) { 
    const hn = limparNome(h), an = limparNome(a); 
    const hs = TIMES_FORTES.some(t=>hn.includes(t)), as = TIMES_FORTES.some(t=>an.includes(t)); 
    let c=2.40, e=3.20, f=2.80; 
    if(hs&&as){c=2.30;e=3.10;f=2.90;}
    else if(hs&&!as){c=1.45;e=4.00;f=6.50;}
    else if(!hs&&as){c=5.50;e=3.80;f=1.55;} 
    c+=(Math.random()*0.1); 
    return {casa:c, empate:e, fora:f}; 
}

function gerarListaGarantida(base, betsApi) {
    const fx = (v) => (v * CONFIG.LUCRO_CASA).toFixed(2);
    const getGol = (val, fo, fu) => { 
        if(betsApi) { 
            const m5=betsApi.find(b=>b.id===5); 
            if(m5) { const o=findOdd(m5, `Over ${val}`), u=findOdd(m5, `Under ${val}`); if(o&&u) return {over:fx(o), under:fx(u)}; } 
        } 
        return {over:fx(fo), under:fx(fu)}; 
    };
    let btts = null; 
    if(betsApi) { const m8=betsApi.find(b=>b.id===8); if(m8) { const s=findOdd(m8, 'Yes'), n=findOdd(m8, 'No'); if(s&&n) btts={s:fx(s), n:fx(n)}; } } 
    if(!btts) { let by=1.90; if(base.empate<3.2) by=1.75; btts={s:fx(by), n:fx((1/(1-(1/by)))*1.05)}; }
    let dc = null; 
    if(betsApi) { const m12=betsApi.find(b=>b.id===12); if(m12) { const ce=findOdd(m12, 'Home/Draw'), cf=findOdd(m12, 'Home/Away'), ef=findOdd(m12, 'Draw/Away'); if(ce&&cf&&ef) dc={c:fx(ce), f:fx(cf), e:fx(ef)}; } } 
    if(!dc) dc={c:fx(1/(1/base.casa+1/base.empate)), f:fx(1/(1/base.casa+1/base.fora)), e:fx(1/(1/base.empate+1/base.fora))};
    return [
        { grupo: "Total de Gols", itens: [ {nome:"Mais 0.5", odd:getGol(0.5, 1.06, 10.0).over}, {nome:"Menos 0.5", odd:getGol(0.5, 1.06, 10.0).under}, {nome:"Mais 1.5", odd:getGol(1.5, 1.29, 3.40).over}, {nome:"Menos 1.5", odd:getGol(1.5, 1.29, 3.40).under}, {nome:"Mais 2.5", odd:getGol(2.5, 1.95, 1.85).over}, {nome:"Menos 2.5", odd:getGol(2.5, 1.95, 1.85).under}, {nome:"Mais 3.5", odd:getGol(3.5, 3.30, 1.30).over}, {nome:"Menos 3.5", odd:getGol(3.5, 3.30, 1.30).under} ] },
        { grupo: "Ambas Marcam", itens: [ {nome:"Sim", odd:btts.s}, {nome:"Não", odd:btts.n} ] },
        { grupo: "Chance Dupla", itens: [ {nome:"Casa/Empate", odd:dc.c}, {nome:"Casa/Fora", odd:dc.f}, {nome:"Empate/Fora", odd:dc.e} ] },
        { grupo: "Placar Exato", itens: [ {nome:"1-0", odd:fx(base.casa*3.2)}, {nome:"2-0", odd:fx(base.casa*5.0)}, {nome:"0-1", odd:fx(base.fora*3.2)}, {nome:"0-2", odd:fx(base.fora*5.0)}, {nome:"1-1", odd:fx(6.00)}, {nome:"0-0", odd:fx(8.50)} ] }
    ];
}

app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V79 (Correção BD) On!"));
