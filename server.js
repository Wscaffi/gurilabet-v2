const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path'); // Importante para carregar o site

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// --- O TRUQUE: SERVIR O SEU INDEX.HTML NOVO ---
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
// ----------------------------------------------

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Banco de Dados
async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (
            id SERIAL PRIMARY KEY, nome TEXT, email TEXT UNIQUE, senha TEXT, saldo NUMERIC DEFAULT 0.00
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (
            id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, 
            valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', 
            detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        console.log("✅ Banco Conectado!");
    } catch (e) { console.error("Erro Banco:", e.message); }
}
initDb();

// --- ROTA DE JOGOS (COM PROTEÇÃO DE FALHA DA API) ---
app.get('/api/jogos', async (req, res) => {
    try {
        const headers = { 
            'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
            'x-rapidapi-host': 'v3.football.api-sports.io'
        };
        
        let url = '';
        let isAoVivo = req.query.aovivo === 'true';
        
        if (isAoVivo) {
            url = `https://v3.football.api-sports.io/fixtures?live=all`;
        } else {
            const hoje = new Date().toISOString().split('T')[0];
            const dataFiltro = req.query.data || hoje;
            url = `https://v3.football.api-sports.io/fixtures?date=${dataFiltro}`;
        }

        // Tenta buscar na API Oficial
        const resp = await axios.get(url, { headers, timeout: 10000 });
        
        // Se a API bloquear ou vier vazia
        if ((!resp.data.response || resp.data.response.length === 0) && !isAoVivo) {
            throw new Error("API Vazia ou Limite");
        }

        res.json(formatar(resp.data.response));

    } catch (e) {
        console.log("⚠️ API OFF/Limitada. Usando Backup.");
        // DATA DE HOJE PARA OS JOGOS FALSOS
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
        return montarObjetoJogo(j);
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
        odds: { 
            casa: (1.5 + Math.random()).toFixed(2), 
            empate: (3.0 + Math.random()).toFixed(2), 
            fora: (2.2 + Math.random() * 2).toFixed(2) 
        },
        mercados: {
            dupla_chance: { casa_empate: "1.25", casa_fora: "1.30", empate_fora: "1.60" },
            ambas_marcam: { sim: "1.75", nao: "1.95" },
            total_gols: { mais_15: "1.30", menos_15: "3.20", mais_25: "1.90", menos_25: "1.80" },
            placar_exato: { "1-0": "6.00", "2-0": "9.00", "2-1": "9.50", "0-0": "8.00" },
            intervalo_final: { "Casa/Casa": "2.50", "Empate/Empate": "4.50", "Fora/Fora": "5.00" }
        }
    };
}

// JOGOS DE BACKUP (Para quando a API cair)
function gerarJogosFalsos(dataStr) {
    const times = [
        {n: "Flamengo", l: "https://media.api-sports.io/football/teams/127.png"},
        {n: "Palmeiras", l: "https://media.api-sports.io/football/teams/121.png"},
        {n: "Real Madrid", l: "https://media.api-sports.io/football/teams/541.png"},
        {n: "Barcelona", l: "https://media.api-sports.io/football/teams/529.png"}
    ];
    const ligas = [
        {n: "Brasileirão Série A", p: "Brazil", f: "https://media.api-sports.io/flags/br.svg"},
        {n: "Champions League", p: "World", f: "https://media.api-sports.io/flags/eu.svg"}
    ];
    
    let lista = [];
    let hora = 19;
    for(let i=0; i<6; i++) {
        let t1 = times[Math.floor(Math.random()*times.length)];
        let t2 = times[Math.floor(Math.random()*times.length)];
        if(t1.n===t2.n) t2 = times[(times.indexOf(t2)+1)%times.length];
        let l = ligas[i%2];
        let d = new Date(dataStr); d.setHours(hora+i, 0, 0);
        
        lista.push(montarObjetoJogo({
            fixture: { id: 9000+i, date: d.toISOString(), status: { short: "NS" } },
            league: { name: l.n, logo: l.f, country: l.p, flag: l.f },
            teams: { home: { name: t1.n, logo: t1.l }, away: { name: t2.n, logo: t2.l } }
        }));
    }
    return lista;
}

// ROTA DE LOGIN
app.post('/api/login', async (req, res) => {
    try {
        const { email, senha } = req.body;
        const hash = crypto.createHash('sha256').update(senha).digest('hex');
        const result = await pool.query('SELECT id, nome, saldo FROM usuarios WHERE email = $1 AND senha = $2', [email, hash]);
        if (result.rows.length > 0) res.json({ sucesso: true, usuario: result.rows[0] });
        else res.status(401).json({ erro: "Dados incorretos." });
    } catch (e) { res.status(500).json({ erro: "Erro servidor." }); }
});

// ROTA DE CADASTRO
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
        await pool.query(
            'INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)',
            [userId, codigo, valor, ret, odd_total, JSON.stringify(apostas)]
        );
        res.json({ sucesso: true, codigo, retorno: ret });
    } catch (e) { 
        // Fallback usuário genérico
        try {
            await pool.query("INSERT INTO usuarios (id, nome, email, senha) VALUES (1, 'Visitante', 'v@v.com', '123') ON CONFLICT DO NOTHING");
            await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', [1, codigo, valor, ret, odd_total, JSON.stringify(apostas)]);
            res.json({ sucesso: true, codigo, retorno: ret });
        } catch(err) { res.status(500).json({ erro: "Erro ao apostar" }); }
    }
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
