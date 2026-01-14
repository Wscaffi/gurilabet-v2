const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, nome TEXT, email TEXT UNIQUE, senha TEXT, saldo NUMERIC DEFAULT 0.00)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        console.log("✅ Banco Conectado!");
    } catch (e) { console.error("Erro Banco:", e.message); }
}
initDb();

// --- FUNÇÃO GERADORA DE MERCADOS COMPLEXOS ---
function gerarMercadosCompletos() {
    const r = () => Math.random(); // Atalho
    return {
        // PRINCIPAIS
        dupla_chance: { 
            casa_empate: (1.20 + r()*0.2).toFixed(2), 
            casa_fora: (1.25 + r()*0.2).toFixed(2), 
            empate_fora: (1.50 + r()*0.4).toFixed(2) 
        },
        empate_anula: { casa: (1.40 + r()*0.3).toFixed(2), fora: (1.80 + r()*0.5).toFixed(2) },
        resultado_final: { casa: (1.80+r()).toFixed(2), empate: (3.00+r()).toFixed(2), fora: (2.50+r()).toFixed(2) },
        
        // GOLS
        total_gols_par_impar: { par: "1.90", impar: "1.90" },
        total_gols_exatos: { "0": "9.00", "1": "4.50", "2": "3.40", "3": "3.80", "4+": "5.00" },
        ambas_marcam: { sim: (1.70 + r()*0.3).toFixed(2), nao: (1.90 + r()*0.3).toFixed(2) },
        ambas_marcam_resultado: { "Sim/Casa": (3.50+r()).toFixed(2), "Sim/Fora": (5.50+r()).toFixed(2), "Sim/Empate": (4.20+r()).toFixed(2) },
        gols_acima_abaixo: { 
            "Mais 1.5": (1.25+r()*0.2).toFixed(2), "Menos 1.5": (3.20+r()).toFixed(2),
            "Mais 2.5": (1.80+r()*0.4).toFixed(2), "Menos 2.5": (1.90+r()*0.2).toFixed(2)
        },
        
        // TEMPOS
        vencedor_1_tempo: { casa: (2.40+r()).toFixed(2), empate: (2.10+r()).toFixed(2), fora: (3.50+r()).toFixed(2) },
        vencedor_2_tempo: { casa: (2.20+r()).toFixed(2), empate: (2.30+r()).toFixed(2), fora: (3.20+r()).toFixed(2) },
        ambas_marcam_1_tempo: { sim: (4.50+r()).toFixed(2), nao: (1.15+r()).toFixed(2) },
        ambas_marcam_2_tempo: { sim: (3.50+r()).toFixed(2), nao: (1.25+r()).toFixed(2) },
        
        // ESCANTEIOS
        escanteios_total: { "Mais 8": (1.40+r()*0.3).toFixed(2), "Mais 10": (2.10+r()*0.5).toFixed(2), "Menos 10": (1.65+r()*0.2).toFixed(2) },
        escanteios_equipe: { "Casa +4.5": (1.70+r()).toFixed(2), "Fora +4.5": (2.20+r()).toFixed(2) },
        
        // ESPECIAIS
        placar_exato: { "1-0":(6.00+r()).toFixed(2), "2-0":(8.50+r()).toFixed(2), "2-1":(9.00+r()).toFixed(2), "0-0":(8.00+r()).toFixed(2), "1-1":(6.50+r()).toFixed(2) },
        intervalo_final: { "Casa/Casa":(2.80+r()).toFixed(2), "Empate/Casa":(4.50+r()).toFixed(2), "Empate/Empate":(4.80+r()).toFixed(2), "Fora/Fora":(5.50+r()).toFixed(2) },
        jogador_marca: { "Artilheiro Casa": (2.20+r()).toFixed(2), "Artilheiro Fora": (3.10+r()).toFixed(2) }
    };
}

// --- ROTA DE JOGOS ---
app.get('/api/jogos', async (req, res) => {
    try {
        const headers = { 'x-rapidapi-key': process.env.API_FOOTBALL_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' };
        let url = req.query.aovivo === 'true' ? `https://v3.football.api-sports.io/fixtures?live=all` : `https://v3.football.api-sports.io/fixtures?date=${req.query.data || new Date().toISOString().split('T')[0]}`;
        
        const resp = await axios.get(url, { headers, timeout: 10000 });
        if ((!resp.data.response || resp.data.response.length === 0) && req.query.aovivo !== 'true') throw new Error("API Limit");
        res.json(formatar(resp.data.response));
    } catch (e) {
        console.log("⚠️ API OFF. Usando Backup Completo.");
        res.json(gerarJogosFalsos(req.query.data || new Date().toISOString().split('T')[0]));
    }
});

function formatar(data) {
    const agora = new Date();
    return data.map(j => {
        const dataJogo = new Date(j.fixture.date);
        const status = j.fixture.status.short;
        const isFuturo = status === 'NS' || status === 'TBD';
        const isAoVivo = ['1H', '2H', 'HT', 'ET', 'P', 'BT'].includes(status);
        if (!isFuturo && !isAoVivo) return null;
        
        // Gera objeto e injeta os mercados completos
        let jogo = montarObjetoJogo(j);
        jogo.mercados = gerarMercadosCompletos(); // Injeta os 30+ mercados
        return jogo;
    }).filter(j => j !== null);
}

function montarObjetoJogo(j) {
    return {
        id: j.fixture.id,
        liga: j.league.name,
        logo_liga: j.league.logo,
        pais: j.league.country,
        bandeira_pais: j.league.flag || j.league.logo,
        home: { name: j.teams.home.name, logo: j.teams.home.logo },
        away: { name: j.teams.away.name, logo: j.teams.away.logo },
        data: j.fixture.date,
        status: j.fixture.status.short,
        ativo: true,
        odds: { casa: (1.5 + Math.random()).toFixed(2), empate: (3.0 + Math.random()).toFixed(2), fora: (2.2 + Math.random() * 2).toFixed(2) }
    };
}

function gerarJogosFalsos(dataStr) {
    const times = [{n:"Flamengo",l:"https://media.api-sports.io/football/teams/127.png"}, {n:"Palmeiras",l:"https://media.api-sports.io/football/teams/121.png"}, {n:"Real Madrid",l:"https://media.api-sports.io/football/teams/541.png"}, {n:"Barcelona",l:"https://media.api-sports.io/football/teams/529.png"}];
    const ligas = [{n:"Brasileirão A",p:"Brazil",f:"https://media.api-sports.io/flags/br.svg"}, {n:"Champions League",p:"World",f:"https://media.api-sports.io/flags/eu.svg"}];
    let lista = [];
    for(let i=0; i<6; i++) {
        let t1 = times[Math.floor(Math.random()*times.length)];
        let t2 = times[Math.floor(Math.random()*times.length)];
        if(t1.n===t2.n) t2 = times[(times.indexOf(t2)+1)%times.length];
        let d = new Date(dataStr); d.setHours(19+i, 0, 0);
        let j = montarObjetoJogo({ fixture: { id: 9000+i, date: d.toISOString(), status: { short: "NS" } }, league: { name: ligas[i%2].n, logo: ligas[i%2].f, country: ligas[i%2].p, flag: ligas[i%2].f }, teams: { home: { name: t1.n, logo: t1.l }, away: { name: t2.n, logo: t2.l } } });
        j.mercados = gerarMercadosCompletos();
        lista.push(j);
    }
    return lista;
}

// Rotas de Auth e Aposta (Mantidas)
app.post('/api/login', async (req, res) => {
    try {
        const { email, senha } = req.body;
        const hash = crypto.createHash('sha256').update(senha).digest('hex');
        const result = await pool.query('SELECT id, nome, saldo FROM usuarios WHERE email = $1 AND senha = $2', [email, hash]);
        if (result.rows.length > 0) res.json({ sucesso: true, usuario: result.rows[0] });
        else res.status(401).json({ erro: "Dados incorretos." });
    } catch (e) { res.status(500).json({ erro: "Erro servidor." }); }
});

app.post('/api/cadastro', async (req, res) => {
    try {
        const { nome, email, senha } = req.body;
        const hash = crypto.createHash('sha256').update(senha).digest('hex');
        const result = await pool.query('INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo', [nome, email, hash]);
        res.json({ sucesso: true, usuario: result.rows[0] });
    } catch (e) { res.status(400).json({ erro: "Email já existe." }); }
});

app.post('/api/finalizar', async (req, res) => {
    const { usuario_id, valor, apostas, odd_total } = req.body;
    const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
    const userId = usuario_id || 1;
    let ret = parseFloat(valor * odd_total).toFixed(2);
    if(ret > 2500) ret = 2500.00;
    try {
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', [userId, codigo, valor, ret, odd_total, JSON.stringify(apostas)]);
        res.json({ sucesso: true, codigo, retorno: ret });
    } catch (e) { 
        try {
            await pool.query("INSERT INTO usuarios (id, nome, email, senha) VALUES (1, 'Visitante', 'v@v.com', '123') ON CONFLICT DO NOTHING");
            await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', [1, codigo, valor, ret, odd_total, JSON.stringify(apostas)]);
            res.json({ sucesso: true, codigo, retorno: ret });
        } catch(err) { res.status(500).json({ erro: "Erro ao apostar" }); }
    }
});

app.get('/api/bilhete/:codigo', async (req, res) => {
    try {
        const { codigo } = req.params;
        const result = await pool.query(`SELECT b.*, u.nome as cliente FROM bilhetes b LEFT JOIN usuarios u ON b.usuario_id = u.id WHERE b.codigo = $1`, [codigo]);
        if(result.rows.length > 0) res.json({ sucesso: true, bilhete: result.rows[0] });
        else res.json({ sucesso: false, erro: "Não encontrado" });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.listen(process.env.PORT || 3000);
