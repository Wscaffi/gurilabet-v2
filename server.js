const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const CONFIG = {
    API_KEY: process.env.API_FOOTBALL_KEY || "SUA_CHAVE_AQUI", 
    LUCRO_CASA: 0.93, // Margem de 7% (Bem próxima da real)
    
    // --- MODO SEGURO ATIVADO ---
    // 60 Minutos de Cache. 
    // Atualiza 24 vezes por dia. 
    // Custo: 24 atualizações x 4 chamadas = 96 requests (Limite é 100).
    TEMPO_CACHE_MINUTOS: 60, 
    
    MIN_VALOR: 2.00,
    MAX_VALOR: 1000.00,
    MAX_PREMIO: 10000.00,
    LIGAS_VIP: ["Premier League", "La Liga", "Serie A", "Brasileirão", "Paulista", "Carioca", "Champions League", "Libertadores"]
};

const TRADUCOES = { "World": "Mundo", "Brazil": "Brasil", "England": "Inglaterra", "Spain": "Espanha", "Italy": "Itália", "Germany": "Alemanha", "France": "França", "Portugal": "Portugal", "Premier League": "Premier League", "Serie A": "Série A", "La Liga": "La Liga", "Carioca - 1": "Carioca", "Paulista - A1": "Paulista A1", "Copa Libertadores": "Libertadores", "UEFA Champions League": "Champions League" };
function traduzir(txt) { return TRADUCOES[txt] || txt; }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS jogos_cache (id SERIAL PRIMARY KEY, data_ref TEXT UNIQUE, json_dados JSONB, atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        
        // Limpeza forçada ao reiniciar para garantir dados novos
        await pool.query("DELETE FROM jogos_cache"); 
        console.log("✅ Servidor V65 (Modo Seguro 60min) Online!");
    } catch (e) { console.error(e); }
}
initDb();

app.get('/api/jogos', async (req, res) => {
    const dataHoje = req.query.data || new Date().toISOString().split('T')[0];
    try {
        // 1. Verifica Cache (Agora com 60 min de validade)
        const cache = await pool.query("SELECT json_dados, atualizado_em FROM jogos_cache WHERE data_ref = $1", [dataHoje]);
        if (cache.rows.length > 0) {
            const diff = (new Date() - new Date(cache.rows[0].atualizado_em)) / 1000 / 60;
            if (diff < CONFIG.TEMPO_CACHE_MINUTOS) {
                console.log(`📦 Cache Válido (${diff.toFixed(0)} min). Economizando API.`);
                return res.json(cache.rows[0].json_dados);
            }
        }
        
        console.log(`🌍 V65: Baixando TUDO (Modo Seguro) para ${dataHoje}...`);
        const headers = { 'x-apisports-key': CONFIG.API_KEY };

        // 1. Jogos
        const respJogos = await axios.get(`https://v3.football.api-sports.io/fixtures?date=${dataHoje}&timezone=America/Sao_Paulo`, { headers });
        const listaBruta = respJogos.data.response || [];

        // 2. Odds (Páginas 1, 2 e 3)
        // Como o cache é longo, podemos gastar essas chamadas agora com segurança.
        let mapaOdds = {};
        for (let p = 1; p <= 3; p++) {
            try {
                const r = await axios.get(`https://v3.football.api-sports.io/odds?date=${dataHoje}&bookmaker=6&timezone=America/Sao_Paulo&page=${p}`, { headers });
                if (r.data.response) {
                    r.data.response.forEach(o => { 
                        mapaOdds[o.fixture.id] = o.bookmakers[0].bets; 
                    });
                }
                if (!r.data.paging || r.data.paging.current >= r.data.paging.total) break;
            } catch (e) { break; }
        }

        let jogosFinais = formatarV65(listaBruta, mapaOdds, dataHoje);
        
        if (jogosFinais.length > 0) {
            await pool.query(`INSERT INTO jogos_cache (data_ref, json_dados, atualizado_em) VALUES ($1, $2, NOW()) ON CONFLICT (data_ref) DO UPDATE SET json_dados = $2, atualizado_em = NOW()`, [dataHoje, JSON.stringify(jogosFinais)]);
        }
        res.json(jogosFinais);
    } catch (e) { res.json([]); }
});

function formatarV65(listaJogos, mapaOdds, dataFiltro) {
    return listaJogos.map(j => {
        try {
            // Filtro Data Local
            const dataLocal = j.fixture.date.substring(0, 10); 
            if (dataLocal !== dataFiltro) return null;

            const st = j.fixture.status.short;
            
            // Status do Placar
            let statusFinal = "VS";
            let placar = null;
            if (['FT', 'AET', 'PEN'].includes(st)) {
                statusFinal = "FT";
                placar = { home: j.goals.home ?? 0, away: j.goals.away ?? 0 };
            } else if (['1H', '2H', 'HT', 'ET', 'P', 'BT', 'INT', 'LIVE'].includes(st)) {
                statusFinal = "LIVE";
                placar = { home: j.goals.home ?? 0, away: j.goals.away ?? 0 };
            }

            let oddsFinais = null;
            let mercadosCalculados = [];

            if (statusFinal === "VS") {
                const betsReais = mapaOdds[j.fixture.id]; 
                let oddsBase = null;

                if (betsReais) {
                    const m1 = betsReais.find(b => b.id === 1);
                    if (m1) {
                        oddsBase = {
                            casa: findOdd(m1, 'Home'),
                            empate: findOdd(m1, 'Draw'),
                            fora: findOdd(m1, 'Away')
                        };
                    }
                }

                if (!oddsBase) oddsBase = gerarOddUnica(j.teams.home.name, j.teams.away.name);

                oddsFinais = {
                    casa: (oddsBase.casa * CONFIG.LUCRO_CASA).toFixed(2),
                    empate: (oddsBase.empate * CONFIG.LUCRO_CASA).toFixed(2),
                    fora: (oddsBase.fora * CONFIG.LUCRO_CASA).toFixed(2)
                };
                
                mercadosCalculados = gerarMercadosReais(oddsBase, betsReais);
            }

            const ligaNome = `${traduzir(j.league.country)} - ${traduzir(j.league.name)}`.toUpperCase();
            
            return {
                id: j.fixture.id,
                liga: ligaNome,
                flag: j.league.flag || "https://cdn-icons-png.flaticon.com/512/53/53280.png",
                home: { name: j.teams.home.name, logo: j.teams.home.logo },
                away: { name: j.teams.away.name, logo: j.teams.away.logo },
                data: j.fixture.date,
                status: statusFinal,
                placar: placar,
                odds: oddsFinais,
                mercados: mercadosCalculados
            };
        } catch (e) { return null; }
    }).filter(Boolean);
}

function findOdd(market, label) {
    const o = market.values.find(v => v.value.toString() === label.toString());
    return o ? parseFloat(o.odd) : null;
}

function gerarOddUnica(home, away) {
    let seed = 0; const combo = home + away;
    for(let i=0; i<combo.length; i++) seed += combo.charCodeAt(i);
    const varCasa = (seed % 30) / 100;
    const varFora = (seed % 20) / 100;
    return { casa: 2.30 + varCasa, empate: 3.10 + varFora, fora: 2.70 + (0.30 - varCasa) };
}

function gerarMercadosReais(base, betsApi) {
    const margem = CONFIG.LUCRO_CASA;
    const fx = (v) => (v * margem).toFixed(2);
    
    if (!betsApi) return gerarMercadosSimulados(base, margem);

    // 1. GOLS (ID 5)
    const m5 = betsApi.find(b => b.id === 5);
    const getGol = (val) => {
        if(m5) {
            const over = findOdd(m5, `Over ${val}`);
            const under = findOdd(m5, `Under ${val}`);
            if(over && under) return { over: fx(over), under: fx(under) };
        }
        return { over: fx(1.90), under: fx(1.80) }; 
    };

    // 2. AMBAS MARCAM (ID 8)
    const m8 = betsApi.find(b => b.id === 8);
    let btts = { s: fx(1.90), n: fx(1.80) };
    if (m8) {
        const s = findOdd(m8, 'Yes'); const n = findOdd(m8, 'No');
        if(s && n) btts = { s: fx(s), n: fx(n) };
    }

    // 3. CHANCE DUPLA (ID 12)
    const m12 = betsApi.find(b => b.id === 12);
    let dc = { c: fx(1.20), f: fx(1.20), e: fx(1.20) };
    if (m12) {
        const ce = findOdd(m12, 'Home/Draw');
        const cf = findOdd(m12, 'Home/Away');
        const ef = findOdd(m12, 'Draw/Away');
        if(ce && cf && ef) dc = { c: fx(ce), f: fx(cf), e: fx(ef) };
    }

    return [
        {
            grupo: "Total de Gols",
            itens: [
                { nome: "Mais 1.5", odd: getGol(1.5).over }, { nome: "Menos 1.5", odd: getGol(1.5).under },
                { nome: "Mais 2.5", odd: getGol(2.5).over }, { nome: "Menos 2.5", odd: getGol(2.5).under },
                { nome: "Mais 3.5", odd: getGol(3.5).over }, { nome: "Menos 3.5", odd: getGol(3.5).under }
            ]
        },
        {
            grupo: "Ambas Marcam",
            itens: [ { nome: "Sim", odd: btts.s }, { nome: "Não", odd: btts.n } ]
        },
        {
            grupo: "Chance Dupla",
            itens: [ { nome: "Casa/Empate", odd: dc.c }, { nome: "Casa/Fora", odd: dc.f }, { nome: "Empate/Fora", odd: dc.e } ]
        },
        {
            grupo: "Placar Exato",
            itens: [
                { nome: "1-0", odd: fx(base.casa * 3.2) }, { nome: "2-0", odd: fx(base.casa * 5.0) },
                { nome: "0-1", odd: fx(base.fora * 3.2) }, { nome: "0-2", odd: fx(base.fora * 5.0) },
                { nome: "1-1", odd: fx(6.50) }
            ]
        }
    ];
}

function gerarMercadosSimulados(base, margem) {
    const fx = (v) => (v * margem).toFixed(2);
    return [ { grupo: "Total de Gols", itens: [ { nome: "Mais 2.5", odd: fx(1.90) }, { nome: "Menos 2.5", odd: fx(1.80) } ] } ];
}

app.post('/api/finalizar', async (req, res) => {
    try {
        let { usuario_id, valor, apostas } = req.body;
        if(!apostas || !apostas.length) return res.status(400).json({erro: "Vazio"});
        let oddTotal = 1.0; apostas.forEach(a => oddTotal *= parseFloat(a.odd));
        let retorno = parseFloat(valor) * oddTotal;
        if(retorno > CONFIG.MAX_PREMIO) retorno = CONFIG.MAX_PREMIO;
        const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', [usuario_id||1, codigo, valor, retorno.toFixed(2), oddTotal.toFixed(2), JSON.stringify(apostas)]);
        res.json({sucesso: true, codigo, retorno: retorno.toFixed(2)});
    } catch (e) { res.status(500).json({erro: "Erro"}); }
});
app.get('/api/admin/resumo', async (req, res) => { try { const f = await pool.query(`SELECT COUNT(*) as t, SUM(valor) as e, SUM(retorno) as r FROM bilhetes`); const u = await pool.query(`SELECT codigo, valor, retorno, data FROM bilhetes ORDER BY data DESC LIMIT 10`); res.json({ caixa: { total: f.rows[0].t, entrada: `R$ ${parseFloat(f.rows[0].e||0).toFixed(2)}`, risco: `R$ ${parseFloat(f.rows[0].r||0).toFixed(2)}` }, ultimos: u.rows }); } catch (e) { res.status(500).json({ erro: "Erro" }); } });
app.post('/api/login', async (req, res) => { res.json({sucesso:false}); });
app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V65 On!"));
