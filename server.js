const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// =====================================================
// CONFIGURAÇÕES GERAIS - V89 (BUSCA QUALQUER CASA DE APOSTA)
// =====================================================
const CONFIG = {
    API_KEY: process.env.API_FOOTBALL_KEY || "SUA_CHAVE_AQUI", 
    
    // COLOQUEI 1.0 PARA A ODD FICAR IDÊNTICA À DA BET365/API (SEM DESCONTO)
    // Se quiser lucrar depois, mude para 0.95 ou 0.90
    LUCRO_CASA: 1.00, 
    
    TEMPO_CACHE_MINUTOS: 45, 
    MIN_VALOR: 2.00,
    MAX_VALOR: 1000.00,
    MAX_PREMIO: 10000.00,
    
    // Aumentei para garantir que leia todos os jogos
    MAX_PAGINAS_ODDS: 15 
};

// TIMES FORTES (Só usa se a API falhar TOTALMENTE em todas as casas)
const TIMES_FORTES = [
    "flamengo", "palmeiras", "atletico-mg", "real madrid", "barcelona", "man city", "liverpool", "psg", "bayern", "inter", "arsenal", 
    "botafogo", "sao paulo", "corinthians", "gremio", "boca juniors", "river plate", "juventus", "milan", "vasco", "fluminense",
    "santos", "cruzeiro", "internacional", "bahia", "athletico-pr", "fortaleza", "vitoria", "sport", "ceara",
    "bragantino", "red bull", "rb bragantino", "cuiaba", "atletico-go", "juventude", "chelsea", "man utd", "tottenham", "napoli"
];

const TRADUCOES = { "World": "Mundo", "Brazil": "Brasil", "England": "Inglaterra", "Spain": "Espanha", "Italy": "Itália", "Germany": "Alemanha", "France": "França", "Portugal": "Portugal", "Premier League": "Premier League", "Serie A": "Série A", "La Liga": "La Liga", "Carioca - 1": "Carioca", "Paulista - A1": "Paulista A1", "Copa Libertadores": "Libertadores" };
function traduzir(txt) { return TRADUCOES[txt] || txt; }
function limparNome(nome) { return nome.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', detalhes JSONB, cliente TEXT, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS jogos_cache (id SERIAL PRIMARY KEY, data_ref TEXT UNIQUE, json_dados JSONB, atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`ALTER TABLE bilhetes ADD COLUMN IF NOT EXISTS cliente TEXT`);
        await pool.query(`ALTER TABLE bilhetes ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pendente'`);
        await pool.query(`ALTER TABLE bilhetes ADD COLUMN IF NOT EXISTS detalhes JSONB`);
        console.log("✅ Servidor V89 (Odds Reais - Qualquer Casa) Online!");
    } catch (e) { console.error("Erro Banco:", e.message); }
}
initDb();

// --- ROTA DE JOGOS ---
app.get('/api/jogos', async (req, res) => {
    const dataHoje = req.query.data || new Date().toISOString().split('T')[0];
    try {
        const cache = await pool.query("SELECT json_dados, atualizado_em FROM jogos_cache WHERE data_ref = $1", [dataHoje]);
        if (cache.rows.length > 0) {
            const diff = (new Date() - new Date(cache.rows[0].atualizado_em)) / 1000 / 60;
            if (diff < CONFIG.TEMPO_CACHE_MINUTOS) return res.json(cache.rows[0].json_dados);
        }
        
        console.log(`🌍 V89: Buscando Odds (Sem filtro de Bookmaker)...`);
        const headers = { 'x-apisports-key': CONFIG.API_KEY };
        const respJogos = await axios.get(`https://v3.football.api-sports.io/fixtures?date=${dataHoje}&timezone=America/Sao_Paulo`, { headers });
        const listaBruta = respJogos.data.response || [];

        let mapaOdds = {};
        try {
            let page = 1; let totalPages = 1;
            do {
                // REMOVI O &bookmaker=6. AGORA PEGA QUALQUER UMA (Bet365, 1xBet, etc)
                const r = await axios.get(`https://v3.football.api-sports.io/odds?date=${dataHoje}&timezone=America/Sao_Paulo&page=${page}`, { headers });
                
                if(r.data.response) {
                    r.data.response.forEach(o => { 
                        // Pega a primeira casa de aposta que aparecer (Geralmente é a melhor disponível na API)
                        if(o.bookmakers && o.bookmakers.length > 0) {
                            mapaOdds[o.fixture.id] = o.bookmakers[0].bets; 
                        }
                    });
                }
                
                totalPages = r.data.paging.total;
                page++;
                await new Promise(resolve => setTimeout(resolve, 300));
            } while (page <= totalPages && page <= CONFIG.MAX_PAGINAS_ODDS);
        } catch (e) { console.log("⚠️ API Odds limitou/falhou."); }

        let jogosFinais = formatarV89(listaBruta, mapaOdds, dataHoje);
        
        if (jogosFinais.length > 0) {
            await pool.query(`INSERT INTO jogos_cache (data_ref, json_dados, atualizado_em) VALUES ($1, $2, NOW()) ON CONFLICT (data_ref) DO UPDATE SET json_dados = $2, atualizado_em = NOW()`, [dataHoje, JSON.stringify(jogosFinais)]);
        }
        res.json(jogosFinais);
    } catch (e) { 
        const cacheBackup = await pool.query("SELECT json_dados FROM jogos_cache WHERE data_ref = $1", [dataHoje]);
        if(cacheBackup.rows.length > 0) return res.json(cacheBackup.rows[0].json_dados);
        res.json([]); 
    }
});

// --- ROTA FINALIZAR ---
app.post('/api/finalizar', async (req, res) => {
    try {
        let { usuario_id, valor, apostas, cliente, forcar } = req.body;
        if(!apostas || !apostas.length) return res.status(400).json({erro: "Carrinho vazio"});
        if(!valor) return res.status(400).json({erro: "Valor inválido"});
        
        const dataHoje = new Date().toISOString().split('T')[0];
        const cache = await pool.query("SELECT json_dados FROM jogos_cache WHERE data_ref = $1", [dataHoje]);
        
        if(cache.rows.length > 0 && !forcar) {
            const jogosAtuais = cache.rows[0].json_dados;
            let mudancas = [];
            for(let aposta of apostas) {
                const jogoAtual = jogosAtuais.find(j => j.id === aposta.id);
                if(jogoAtual) {
                    let oddAtual = buscarOddNoJogo(jogoAtual, aposta.opcao);
                    // Tolerância 0.25
                    if(oddAtual && Math.abs(parseFloat(oddAtual) - parseFloat(aposta.odd)) > 0.25) {
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
        
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes, cliente, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', 
            [usuario_id||1, codigo, valor, retorno.toFixed(2), oddTotal.toFixed(2), JSON.stringify(apostas), cliente || "Anônimo", "pendente"]);
            
        res.json({sucesso: true, codigo, retorno: retorno.toFixed(2)});
    } catch (e) { res.status(500).json({erro: e.message || "Erro interno"}); }
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

// --- ROTAS ADMIN ---
app.get('/api/admin/pendentes', async (req, res) => { try { const r = await pool.query("SELECT * FROM bilhetes WHERE status = 'pendente' ORDER BY data DESC"); res.json(r.rows); } catch (e) { res.status(500).json({erro: "Erro banco"}); } });
app.post('/api/admin/validar', async (req, res) => { try { await pool.query("UPDATE bilhetes SET status = 'validado' WHERE codigo = $1", [req.body.codigo]); res.json({sucesso: true}); } catch (e) { res.status(500).json({erro: "Erro"}); } });
app.post('/api/admin/excluir', async (req, res) => { try { await pool.query("DELETE FROM bilhetes WHERE codigo = $1", [req.body.codigo]); res.json({sucesso: true}); } catch (e) { res.status(500).json({erro: "Erro"}); } });

// --- LÓGICA V89 (SEM FILTRO) ---
function formatarV89(listaJogos, mapaOdds, dataFiltro) {
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
                const nomeCasa = limparNome(j.teams.home.name);
                const nomeFora = limparNome(j.teams.away.name);
                const ehTimeGrande = TIMES_FORTES.some(t => nomeCasa.includes(t) || nomeFora.includes(t));

                let oddsBase = null;

                // TENTA API (QUALQUER CASA AGORA)
                if (betsReais) {
                    const m1 = betsReais.find(b => b.id == 1); 
                    if (m1) oddsBase = { casa: findOdd(m1, 'Home'), empate: findOdd(m1, 'Draw'), fora: findOdd(m1, 'Away') };
                }

                if (!oddsBase) {
                    // SEM API -> GERA MATH
                    oddsBase = gerarOddInteligente(j.teams.home.name, j.teams.away.name);
                    oddsFinais = { 
                        casa: (oddsBase.casa * CONFIG.LUCRO_CASA).toFixed(2), 
                        empate: (oddsBase.empate * CONFIG.LUCRO_CASA).toFixed(2), 
                        fora: (oddsBase.fora * CONFIG.LUCRO_CASA).toFixed(2) 
                    };
                    
                    if (ehTimeGrande) {
                        mercadosCalculados = gerarListaSintetica(oddsBase); 
                    } else {
                        mercadosCalculados = []; // Bloqueia várzea
                    }
                } else {
                    // COM API (REAL)
                    oddsFinais = { 
                        casa: (oddsBase.casa * CONFIG.LUCRO_CASA).toFixed(2), 
                        empate: (oddsBase.empate * CONFIG.LUCRO_CASA).toFixed(2), 
                        fora: (oddsBase.fora * CONFIG.LUCRO_CASA).toFixed(2) 
                    };
                    mercadosCalculados = gerarListaHibrida(oddsBase, betsReais, ehTimeGrande);
                }
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

function gerarListaHibrida(base, betsApi, ehGrande) {
    const fx = (v) => (v * CONFIG.LUCRO_CASA).toFixed(2);
    const lista = [];
    
    // ATENÇÃO: ID PODE SER NUMERO OU TEXTO
    const getM = (id) => betsApi.find(b => b.id == id);

    const m5 = getM(5);
    const golsItems = [];
    [0.5, 1.5, 2.5, 3.5, 4.5].forEach(g => {
        let found = false;
        if(m5) {
            const o = findOdd(m5, `Over ${g}`), u = findOdd(m5, `Under ${g}`);
            if(o && u) { golsItems.push({nome: `Mais ${g}`, odd: fx(o)}); golsItems.push({nome: `Menos ${g}`, odd: fx(u)}); found = true; }
        }
        if(!found && ehGrande && g === 2.5) {
            golsItems.push({nome: `Mais 2.5`, odd: fx(1.90)}); golsItems.push({nome: `Menos 2.5`, odd: fx(1.85)});
        }
    });
    if(golsItems.length) lista.push({ grupo: "Total de Gols", itens: golsItems });

    const m8 = getM(8);
    if(m8) {
        const s = findOdd(m8, 'Yes'), n = findOdd(m8, 'No');
        if(s && n) lista.push({ grupo: "Ambas as equipes marcam", itens: [{nome: "Sim", odd: fx(s)}, {nome: "Não", odd: fx(n)}] });
    } else if(ehGrande) {
        lista.push({ grupo: "Ambas as equipes marcam", itens: [{nome: "Sim", odd: fx(1.90)}, {nome: "Não", odd: fx(1.80)}] });
    }

    const m12 = getM(12);
    if(m12) {
        const ce = findOdd(m12, 'Home/Draw'), cf = findOdd(m12, 'Home/Away'), ef = findOdd(m12, 'Draw/Away');
        if(ce && cf && ef) lista.push({ grupo: "Chance Dupla", itens: [{nome: "Casa/Empate", odd: fx(ce)}, {nome: "Casa/Fora", odd: fx(cf)}, {nome: "Empate/Fora", odd: fx(ef)}] });
    } else if(ehGrande) {
        const dcC = 1 / (1/base.casa + 1/base.empate); const dcF = 1 / (1/base.casa + 1/base.fora); const dcE = 1 / (1/base.empate + 1/base.fora);
        lista.push({ grupo: "Chance Dupla", itens: [{nome: "Casa/Empate", odd: fx(dcC)}, {nome: "Casa/Fora", odd: fx(dcF)}, {nome: "Empate/Fora", odd: fx(dcE)}] });
    }

    const mDnb = betsApi.find(b => b.name === "Draw No Bet" || b.id == 6); if(mDnb) { const c = findOdd(mDnb, 'Home'), f = findOdd(mDnb, 'Away'); if(c && f) lista.push({ grupo: "Empate não tem aposta", itens: [{nome: "Casa", odd: fx(c)}, {nome: "Fora", odd: fx(f)}] }); }
    const m2 = getM(2); if(m2) { const i = findOdd(m2, 'Odd'), p = findOdd(m2, 'Even'); if(i && p) lista.push({ grupo: "Ímpar/Par", itens: [{nome: "Ímpar", odd: fx(i)}, {nome: "Par", odd: fx(p)}] }); }
    const m13 = getM(13); if(m13) { const c = findOdd(m13, 'Home'), e = findOdd(m13, 'Draw'), f = findOdd(m13, 'Away'); if(c && e && f) lista.push({ grupo: "Vencedor do 1º Tempo", itens: [{nome: "Casa", odd: fx(c)}, {nome: "Empate", odd: fx(e)}, {nome: "Fora", odd: fx(f)}] }); }
    const m7 = getM(7); if(m7) { const htft=[]; const mapKeys=[{k:'Home/Home', n:'Casa/Casa'}, {k:'Home/Draw', n:'Casa/Empate'}, {k:'Home/Away', n:'Casa/Fora'}, {k:'Draw/Home', n:'Empate/Casa'}, {k:'Draw/Draw', n:'Empate/Empate'}, {k:'Draw/Away', n:'Empate/Fora'}, {k:'Away/Home', n:'Fora/Casa'}, {k:'Away/Draw', n:'Fora/Empate'}, {k:'Away/Away', n:'Fora/Fora'}]; mapKeys.forEach(p => { const odd = findOdd(m7, p.k); if(odd) htft.push({nome: p.n, odd: fx(odd)}); }); if(htft.length) lista.push({ grupo: "Intervalo / Final", itens: htft }); }
    const m6 = getM(6); if(m6 && m6.values) { const golsHT=[]; m6.values.forEach(v => { if(["Over 0.5", "Under 0.5", "Over 1.5", "Under 1.5"].includes(v.value)) { golsHT.push({nome: v.value.replace("Over", "Mais").replace("Under", "Menos"), odd: fx(v.odd)}); } }); if(golsHT.length) lista.push({ grupo: "Total de Gols 1º Tempo", itens: golsHT }); }
    const m4 = getM(4); if(m4 && m4.values) { const handicaps=[]; m4.values.forEach(v => { if((v.value.includes("Home") || v.value.includes("Away")) && (v.value.includes("-1") || v.value.includes("+1"))) { handicaps.push({nome: v.value.replace("Home", "Casa").replace("Away", "Fora"), odd: fx(v.odd)}); } }); if(handicaps.length) lista.push({ grupo: "Handicap Resultado", itens: handicaps }); }
    const m10 = getM(10); if(m10 && m10.values) { const placares=[]; const permitidos=["1:0","2:0","2:1","3:0","3:1","0:1","0:2","1:2","0:3","1:3","0:0","1:1","2:2"]; m10.values.forEach(v => { if(permitidos.includes(v.value)) placares.push({nome: v.value, odd: fx(v.odd)}); }); if(placares.length) lista.push({ grupo: "Placar Exato", itens: placares }); }
    const m34 = getM(34); if(m34) { const s = findOdd(m34, 'Yes'), n = findOdd(m34, 'No'); if(s && n) lista.push({ grupo: "1º Tempo - Ambas Marcam", itens: [{nome: "Sim", odd: fx(s)}, {nome: "Não", odd: fx(n)}] }); }
    
    return lista;
}

function gerarListaSintetica(base) {
    const fx = (v) => (v * CONFIG.LUCRO_CASA).toFixed(2);
    const lista = [];
    const dcC = 1 / (1/base.casa + 1/base.empate); const dcF = 1 / (1/base.casa + 1/base.fora); const dcE = 1 / (1/base.empate + 1/base.fora);
    lista.push({ grupo: "Chance Dupla", itens: [{nome: "Casa/Empate", odd: fx(dcC)}, {nome: "Casa/Fora", odd: fx(dcF)}, {nome: "Empate/Fora", odd: fx(dcE)}] });
    const dnbC = base.casa * 0.75; const dnbF = base.fora * 0.75;
    lista.push({ grupo: "Empate não tem aposta", itens: [{nome: "Casa", odd: fx(dnbC)}, {nome: "Fora", odd: fx(dnbF)}] });
    let bttsS = 1.90, bttsN = 1.80; if(base.casa < 1.5 || base.fora < 1.5) { bttsS = 2.10; bttsN = 1.65; }
    lista.push({ grupo: "Ambas as equipes marcam", itens: [{nome: "Sim", odd: fx(bttsS)}, {nome: "Não", odd: fx(bttsN)}] });
    lista.push({ grupo: "Total de Gols", itens: [{nome: "Mais 0.5", odd: fx(1.05)}, {nome: "Menos 0.5", odd: fx(8.00)}, {nome: "Mais 1.5", odd: fx(1.30)}, {nome: "Menos 1.5", odd: fx(3.20)}, {nome: "Mais 2.5", odd: fx(1.95)}, {nome: "Menos 2.5", odd: fx(1.85)}, {nome: "Mais 3.5", odd: fx(3.10)}, {nome: "Menos 3.5", odd: fx(1.30)}] });
    lista.push({ grupo: "Ímpar/Par", itens: [{nome: "Ímpar", odd: fx(1.90)}, {nome: "Par", odd: fx(1.90)}] });
    return lista;
}

app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V89 (Odds Reais) On!"));
