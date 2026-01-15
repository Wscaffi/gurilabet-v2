const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json());
// CORS LIBERADO (Para o Vercel conseguir acessar)
app.use(cors({ origin: '*' }));

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- BANCO DE DADOS ---
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
    } catch (e) { console.error("⚠️ Aviso Banco:", e.message); }
}
initDb();

// --- ROTA DE JOGOS (BLINDADA) ---
app.get('/api/jogos', async (req, res) => {
    const dataFiltro = req.query.data || new Date().toISOString().split('T')[0];
    
    try {
        // 1. Tenta pegar da API Oficial se tiver chave
        if (process.env.API_FOOTBALL_KEY) {
            console.log("Tentando API Oficial...");
            const headers = { 
                'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
                'x-rapidapi-host': 'v3.football.api-sports.io'
            };
            const isAoVivo = req.query.aovivo === 'true';
            let url = isAoVivo 
                ? `https://v3.football.api-sports.io/fixtures?live=all`
                : `https://v3.football.api-sports.io/fixtures?date=${dataFiltro}`;

            const resp = await axios.get(url, { headers, timeout: 5000 });
            
            // Se vier jogos, formata e entrega
            if (resp.data.response && resp.data.response.length > 0) {
                const jogosReais = formatar(resp.data.response);
                if (jogosReais.length > 0) {
                    return res.json(jogosReais);
                }
            }
            console.log("API vazia ou jogos encerrados. Indo para backup...");
        }

        // 2. Se não tem chave, ou a API falhou, ou não tem jogos: USA BACKUP
        throw new Error("Ativar Backup");

    } catch (e) {
        console.log("⚠️ Modo Backup Ativado.");
        const backup = gerarJogosFalsos(dataFiltro);
        res.json(backup);
    }
});

// --- FUNÇÃO DE FORMATAÇÃO ---
function formatar(data) {
    return data.map(j => {
        const status = j.fixture.status.short;
        // Filtra jogos encerrados (FT) para não poluir
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
            mercados: gerarMercadosPadrao()
        };
    }).filter(Boolean);
}

// --- GERADOR DE JOGOS FALSOS (COMPLETO) ---
// Se esta função estiver vazia, o site fica vazio. Aqui ela está cheia!
function gerarJogosFalsos(dataBase) {
    const times = [
        {n: "Flamengo", l: "https://media.api-sports.io/football/teams/127.png"},
        {n: "Vasco", l: "https://media.api-sports.io/football/teams/133.png"},
        {n: "Palmeiras", l: "https://media.api-sports.io/football/teams/121.png"},
        {n: "Corinthians", l: "https://media.api-sports.io/football/teams/131.png"},
        {n: "Real Madrid", l: "https://media.api-sports.io/football/teams/541.png"},
        {n: "Barcelona", l: "https://media.api-sports.io/football/teams/529.png"},
        {n: "Man City", l: "https://media.api-sports.io/football/teams/50.png"},
        {n: "Liverpool", l: "https://media.api-sports.io/football/teams/40.png"}
    ];
    const ligas = [
        {n: "Brasileirão Série A", p: "Brazil", f: "https://media.api-sports.io/flags/br.svg"},
        {n: "Champions League", p: "World", f: "https://media.api-sports.io/flags/eu.svg"}
    ];

    let lista = [];
    // Gera 12 jogos
    for(let i=0; i<12; i++) {
        let t1 = times[Math.floor(Math.random() * times.length)];
        let t2 = times[Math.floor(Math.random() * times.length)];
        let liga = ligas[Math.floor(Math.random() * ligas.length)];
        
        // Garante times diferentes
        if(t1.n === t2.n) t2 = times[(times.indexOf(t2) + 1) % times.length];

        // Define horário
        let dataJogo = new Date(dataBase);
        dataJogo.setHours(12 + i, 0, 0); 
        
        // Truque: Se o horário já passou hoje, joga para amanhã para aparecer na lista
        if(new Date() > dataJogo) dataJogo.setDate(dataJogo.getDate() + 1);

        lista.push({
            id: 8000 + i, // ID alto para saber que é falso
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
                casa: (1.80 + (i%5)/10).toFixed(2), 
                empate: (3.20).toFixed(2), 
                fora: (2.50 + (i%3)/10).toFixed(2) 
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

// --- ROTAS (Cadastro, Login, Aposta) ---
app.post('/api/cadastro', async (req, res) => {
    try {
        const { nome, email, senha } = req.body;
        if(!email || !senha) return res.status(400).json({ erro: "Dados inválidos." });
        const hash = await bcrypt.hash(senha, 10);
        const result = await pool.query('INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo', [nome, email, hash]);
        res.json({ sucesso: true, usuario: result.rows[0] });
    } catch (e) { if(e.code === '23505') return res.status(400).json({ erro: "E-mail já cadastrado." }); res.status(500).json({ erro: "Erro servidor." }); }
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
    const retorno = (valor * odd_total).toFixed(2);
    try {
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', 
        [usuario_id || 1, codigo, valor, retorno, odd_total, JSON.stringify(apostas)]);
        res.json({ sucesso: true, codigo, retorno });
    } catch (e) { res.status(500).json({ erro: "Erro aposta" }); }
});

app.get('/api/bilhete/:codigo', async (req, res) => {
    try {
        const result = await pool.query(`SELECT b.*, u.nome as cliente FROM bilhetes b LEFT JOIN usuarios u ON b.usuario_id = u.id WHERE b.codigo = $1`, [req.params.codigo]);
        if(result.rows.length > 0) res.json({ sucesso: true, bilhete: result.rows[0] });
        else res.json({ sucesso: false });
    } catch(e) { res.status(500).json({ erro: "Erro" }); }
});

app.listen(process.env.PORT || 3000, () => console.log("🔥 Server On!"));
