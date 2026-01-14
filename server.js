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

// FUNÇÃO QUE GERA OS MERCADOS EXTRAS (O SEGREDO PARA O BOTÃO + FUNCIONAR)
function gerarMercadosExtras() {
    const r = () => (1 + Math.random() * 5).toFixed(2); // Gera odd entre 1.00 e 6.00
    return {
        dupla_chance: { ce: "1.25", cf: "1.30", ef: "1.60" },
        ambas_marcam: { sim: "1.75", nao: "1.95" },
        gols: { over15: "1.30", under15: "3.20", over25: "1.90", under25: "1.80" },
        placar: { "1x0": "6.00", "2x0": "9.00", "2x1": "8.50", "0x0": "8.00" },
        intervalo: { c: "2.50", e: "2.10", f: "3.50" },
        escanteios: { over8: "1.50", over10: "2.10", under10: "1.65" },
        handicap: { c1: "2.80", e1: "3.40", f1: "1.45" }
    };
}

app.get('/api/jogos', async (req, res) => {
    try {
        const headers = { 'x-rapidapi-key': process.env.API_FOOTBALL_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' };
        let url = req.query.aovivo === 'true' ? `https://v3.football.api-sports.io/fixtures?live=all` : `https://v3.football.api-sports.io/fixtures?date=${req.query.data || new Date().toISOString().split('T')[0]}`;
        
        const resp = await axios.get(url, { headers, timeout: 10000 });
        let fixtures = resp.data.response || [];

        // Se API falhar, gera backup para não ficar vazio
        if (fixtures.length === 0 && req.query.aovivo !== 'true') {
            fixtures = gerarBackup(); 
        }

        const formatados = fixtures.map(j => {
            const m = gerarMercadosExtras(); // GERA OS MERCADOS AQUI
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
                odds: { casa: (1.5+Math.random()).toFixed(2), empate: (3.0+Math.random()).toFixed(2), fora: (2.5+Math.random()).toFixed(2) },
                mercados: m // ENVIA PARA O FRONT
            };
        });

        res.json(formatados);
    } catch (e) {
        res.json(formatar(gerarBackup()));
    }
});

function gerarBackup() {
    // Dados falsos se a API falhar, só para o site abrir
    return [
        {fixture:{id:101,date:new Date().toISOString(),status:{short:'NS'}}, league:{name:"Brasileirão",country:"Brazil",logo:"",flag:""}, teams:{home:{name:"Flamengo",logo:""},away:{name:"Vasco",logo:""}}},
        {fixture:{id:102,date:new Date().toISOString(),status:{short:'NS'}}, league:{name:"Premier League",country:"England",logo:"",flag:""}, teams:{home:{name:"Liverpool",logo:""},away:{name:"Chelsea",logo:""}}}
    ];
}
function formatar(data) {
    return data.map(j => ({
        id: j.fixture.id,
        liga: j.league.name, logo_liga: j.league.logo, pais: j.league.country, bandeira_pais: j.league.flag,
        home: j.teams.home, away: j.teams.away, data: j.fixture.date, status: j.fixture.status.short, ativo: true,
        odds: {casa:"1.90", empate:"3.20", fora:"4.10"},
        mercados: gerarMercadosExtras()
    }));
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
    try {
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', [userId, codigo, valor, ret, odd_total, JSON.stringify(apostas)]);
        res.json({ sucesso: true, codigo, retorno: ret });
    } catch (e) { res.status(500).json({ erro: "Erro ao apostar" }); }
});

// Validação
app.get('/api/bilhete/:codigo', async (req, res) => {
    try {
        const { codigo } = req.params;
        const result = await pool.query(`SELECT b.*, u.nome as cliente FROM bilhetes b LEFT JOIN usuarios u ON b.usuario_id = u.id WHERE b.codigo = $1`, [codigo]);
        if(result.rows.length > 0) res.json({ sucesso: true, bilhete: result.rows[0] });
        else res.json({ sucesso: false, erro: "Não encontrado" });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.listen(process.env.PORT || 3000);
