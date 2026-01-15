const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs'); 

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- INICIALIZAÇÃO DO BANCO ---
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
        
        // Cria usuário Balcão se não existir
        const userCheck = await pool.query("SELECT id FROM usuarios WHERE id = 1");
        if(userCheck.rows.length === 0) {
            const hash = await bcrypt.hash('sistema123', 10);
            await pool.query("INSERT INTO usuarios (id, nome, email, senha) VALUES (1, 'Cliente Balcão', 'sistema@gurila.com', $1)", [hash]);
        }
        console.log("✅ Banco Conectado!");
    } catch (e) { console.error("❌ Erro Banco:", e.message); }
}
initDb();

// --- ROTA DE JOGOS (CORRIGIDA PARA SEMPRE MOSTRAR ALGO) ---
app.get('/api/jogos', async (req, res) => {
    const dataFiltro = req.query.data || new Date().toISOString().split('T')[0];
    
    try {
        // Se não tiver chave, vai pro backup direto
        if (!process.env.API_FOOTBALL_KEY) throw new Error("Sem API Key");

        const headers = { 
            'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
            'x-rapidapi-host': 'v3.football.api-sports.io'
        };
        
        const isAoVivo = req.query.aovivo === 'true';
        let url = isAoVivo 
            ? `https://v3.football.api-sports.io/fixtures?live=all`
            : `https://v3.football.api-sports.io/fixtures?date=${dataFiltro}`;

        const resp = await axios.get(url, { headers, timeout: 5000 });
        
        if (!resp.data.response || resp.data.response.length === 0) throw new Error("Lista Vazia");

        const jogosReais = formatar(resp.data.response);
        
        // SE FILTROU TUDO (Ex: Jogos acabaram), USA FAKE
        if (jogosReais.length === 0) throw new Error("Jogos do dia encerrados");

        res.json(jogosReais);

    } catch (e) {
        console.log(`⚠️ Usando Backup: ${e.message}`);
        // GERA JOGOS FALSOS PARA O DIA SOLICITADO
        res.json(gerarJogosFalsos(dataFiltro));
    }
});

function formatar(data) {
    return data.map(j => {
        const status = j.fixture.status.short;
        // Filtra jogos encerrados para não poluir
        if (['FT', 'AET', 'PEN'].includes(status)) return null;

        return {
            id: j.fixture.id,
            liga: j.league.name,
            logo_liga: j.league.logo,
            pais: j.league.country,
            home: { name: j.teams.home.name, logo: j.teams.home.logo },
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date,
            status: status,
            ativo: true,
            odds: { 
                casa: (1.5 + (j.fixture.id % 10)/20).toFixed(2), 
                empate: (3.0 + (j.fixture.id % 5)/10).toFixed(2), 
                fora: (2.2 + (j.fixture.id % 8)/10).toFixed(2) 
            },
            mercados: gerarMercadosPadrao() // Garante que o botão +45 funcione
        };
    }).filter(Boolean);
}

// --- GERADOR DE JOGOS FALSOS (RECUPERADO E MELHORADO) ---
function gerarJogosFalsos(dataBase) {
    const times = [
        {n: "Flamengo", l: "https://media.api-sports.io/football/teams/127.png"},
        {n: "Vasco", l: "https://media.api-sports.io/football/teams/133.png"},
        {n: "Palmeiras", l: "https://media.api-sports.io/football/teams/121.png"},
        {n: "Corinthians", l: "https://media.api-sports.io/football/teams/131.png"},
        {n: "São Paulo", l: "https://media.api-sports.io/football/teams/126.png"},
        {n: "Real Madrid", l: "https://media.api-sports.io/football/teams/541.png"},
        {n: "Barcelona", l: "https://media.api-sports.io/football/teams/529.png"},
        {n: "Man City", l: "https://media.api-sports.io/football/teams/50.png"},
        {n: "Liverpool", l: "https://media.api-sports.io/football/teams/40.png"},
        {n: "PSG", l: "https://media.api-sports.io/football/teams/85.png"}
    ];

    const ligas = [
        {n: "Brasileirão Série A", p: "Brazil", f: "https://media.api-sports.io/flags/br.svg"},
        {n: "Premier League", p: "England", f: "https://media.api-sports.io/flags/gb.svg"},
        {n: "La Liga", p: "Spain", f: "https://media.api-sports.io/flags/es.svg"},
        {n: "UEFA Champions League", p: "World", f: "https://media.api-sports.io/flags/eu.svg"}
    ];

    let lista = [];
    
    // Gera 15 jogos
    for(let i=0; i<15; i++) {
        let t1 = times[Math.floor(Math.random() * times.length)];
        let t2 = times[Math.floor(Math.random() * times.length)];
        let liga = ligas[Math.floor(Math.random() * ligas.length)];
        
        if(t1.n === t2.n) t2 = times[(times.indexOf(t2) + 1) % times.length];

        // Define horários futuros para parecer real
        let dataJogo = new Date(dataBase);
        dataJogo.setHours(12 + (i%10), 0, 0); 
        // Se for hoje e já passou das 12h, joga pra mais tarde
        if(new Date() > dataJogo) dataJogo.setHours(new Date().getHours() + 1 + i);

        lista.push({
            id: 2000 + i,
            liga: liga.n,
            logo_liga: "https://media.api-sports.io/football/leagues/71.png",
            pais: liga.p,
            bandeira_pais: liga.f,
            home: { name: t1.n, logo: t1.l },
            away: { name: t2.n, logo: t2.l },
            data: dataJogo.toISOString(),
            status: "NS", // Not Started
            ativo: true,
            odds: { 
                casa: (1.5 + (i%5)/10).toFixed(2), 
                empate: (3.0 + (i%3)/10).toFixed(2), 
                fora: (2.5 + (i%4)/10).toFixed(2) 
            },
            mercados: gerarMercadosPadrao()
        });
    }
    return lista;
}

function gerarMercadosPadrao() {
    return {
        dupla_chance: { casa_empate: "1.25", casa_fora: "1.30", empate_fora: "1.60" },
        ambas_marcam: { sim: "1.75", nao: "1.95" },
        total_gols: { mais_15: "1.30", menos_15: "3.20", mais_25: "1.90", menos_25: "1.80" },
        intervalo_final: { "Casa/Casa": "2.50", "Empate/Empate": "4.50", "Fora/Fora": "5.00" }
    };
}

// --- ROTAS DE USUÁRIO E APOSTA ---
app.post('/api/cadastro', async (req, res) => {
    try {
        const { nome, email, senha } = req.body;
        if(!email || !senha || senha.length < 6) return res.status(400).json({ erro: "Dados inválidos." });
        const hash = await bcrypt.hash(senha, 10);
        const result = await pool.query('INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo', [nome, email, hash]);
        res.json({ sucesso: true, usuario: result.rows[0] });
    } catch (e) { 
        console.error(e);
        if(e.code === '23505') return res.status(400).json({ erro: "E-mail já cadastrado." });
        res.status(500).json({ erro: "Erro no servidor." }); 
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, senha } = req.body;
        const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(400).json({ erro: "Login falhou." });
        const user = result.rows[0];
        if (!(await bcrypt.compare(senha, user.senha))) return res.status(400).json({ erro: "Login falhou." });
        delete user.senha;
        res.json({ sucesso: true, usuario: user });
    } catch (e) { res.status(500).json({ erro: "Erro Login" }); }
});

app.post('/api/finalizar', async (req, res) => {
    const { usuario_id, valor, apostas, odd_total } = req.body;
    const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
    let retorno = (valor * odd_total);
    if(retorno > 2500) retorno = 2500;
    
    try {
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', 
        [usuario_id || 1, codigo, valor, retorno.toFixed(2), odd_total, JSON.stringify(apostas)]);
        res.json({ sucesso: true, codigo, retorno: retorno.toFixed(2) });
    } catch (e) { res.status(500).json({ erro: "Erro ao apostar" }); }
});

app.get('/api/bilhete/:codigo', async (req, res) => {
    try {
        const result = await pool.query(`SELECT b.*, u.nome as cliente FROM bilhetes b LEFT JOIN usuarios u ON b.usuario_id = u.id WHERE b.codigo = $1`, [req.params.codigo]);
        if(result.rows.length > 0) res.json({ sucesso: true, bilhete: result.rows[0] });
        else res.json({ sucesso: false });
    } catch(e) { res.status(500).json({ erro: "Erro" }); }
});

app.listen(process.env.PORT || 3000, () => console.log("🔥 Server On!"));
