const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');

// --- 1. INICIALIZAÇÃO CORRETA DO APP (Isso corrige o erro "app is not defined") ---
const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// --- 2. CONEXÃO COM O BANCO DE DADOS ---
// Dica: Certifique-se de ter colocado o Link PÚBLICO do banco na variável DATABASE_URL no Railway
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Ignora erro de certificado
});

// Inicializa tabelas
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
        console.log("✅ Banco de Dados Conectado!");
    } catch (e) { 
        console.error("⚠️ Aviso Banco (Se o site abrir, ignore):", e.message); 
    }
}
initDb();

// --- 3. ROTA DE JOGOS (CORRIGIDA PARA ACEITAR QUALQUER CHAVE) ---
app.get('/api/jogos', async (req, res) => {
    // Pega a data ou usa hoje
    const dataFiltro = req.query.data || new Date().toISOString().split('T')[0];
    
    try {
        console.log(`🔍 Buscando jogos para: ${dataFiltro}`);

        // Verifica se a chave existe
        if (!process.env.API_FOOTBALL_KEY) throw new Error("Sem Chave API configurada");

        // O PULO DO GATO: Mandamos os dois cabeçalhos para garantir que funcione
        const headers = { 
            'x-apisports-key': process.env.API_FOOTBALL_KEY.trim(), // Para conta direta
            'x-rapidapi-key': process.env.API_FOOTBALL_KEY.trim(),  // Para conta RapidAPI
            'x-rapidapi-host': 'v3.football.api-sports.io'
        };
        
        const isAoVivo = req.query.aovivo === 'true';
        let url = isAoVivo 
            ? `https://v3.football.api-sports.io/fixtures?live=all`
            : `https://v3.football.api-sports.io/fixtures?date=${dataFiltro}`;

        const resp = await axios.get(url, { headers, timeout: 6000 });
        
        // Log para vermos se a API respondeu
        console.log(`RESPOSTA API: Status ${resp.status} | Jogos encontrados: ${resp.data.response ? resp.data.response.length : 0}`);

        // Se a API devolver erro explícito (ex: limite diário)
        if (resp.data.errors && Object.keys(resp.data.errors).length > 0) {
            console.error("❌ Erro da API (Limite ou Chave):", JSON.stringify(resp.data.errors));
            throw new Error("Erro na conta da API");
        }

        let fixtures = resp.data.response;
        
        // Se a lista vier vazia, joga erro para ativar o backup
        if (!fixtures || fixtures.length === 0) throw new Error("Lista vazia na API");

        // Formata os jogos reais
        const jogosReais = formatar(fixtures);
        
        if (jogosReais.length === 0) throw new Error("Jogos existem mas foram filtrados (encerrados)");

        console.log(`✅ Sucesso! Enviando ${jogosReais.length} jogos reais.`);
        res.json(jogosReais);

    } catch (e) {
        console.log(`⚠️ Falha na API (${e.message}). Ativando Jogos Falsos.`);
        res.json(gerarJogosFalsos(dataFiltro));
    }
});

// --- FUNÇÕES AUXILIARES ---
function formatar(data) {
    return data.map(j => {
        const status = j.fixture.status.short;
        // Filtra jogos encerrados (FT, AET, PEN)
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

function gerarJogosFalsos(dataBase) {
    const times = [
        {n: "Flamengo", l: "https://media.api-sports.io/football/teams/127.png"},
        {n: "Vasco", l: "https://media.api-sports.io/football/teams/133.png"},
        {n: "Palmeiras", l: "https://media.api-sports.io/football/teams/121.png"},
        {n: "Corinthians", l: "https://media.api-sports.io/football/teams/131.png"},
        {n: "Real Madrid", l: "https://media.api-sports.io/football/teams/541.png"},
        {n: "Barcelona", l: "https://media.api-sports.io/football/teams/529.png"}
    ];
    const ligas = [{n: "Brasileirão Série A", p: "Brazil", f: "https://media.api-sports.io/flags/br.svg"}];
    let lista = [];
    for(let i=0; i<15; i++) {
        let t1 = times[Math.floor(Math.random() * times.length)];
        let t2 = times[Math.floor(Math.random() * times.length)];
        if(t1.n === t2.n) t2 = times[(times.indexOf(t2) + 1) % times.length];
        
        let dataJogo = new Date(dataBase);
        dataJogo.setHours(13 + i, 0, 0); 
        // Se já passou do horário, joga pra amanhã
        if(new Date() > dataJogo) dataJogo.setDate(dataJogo.getDate() + 1);

        lista.push({
            id: 7000 + i,
            liga: ligas[0].n, logo_liga: "https://media.api-sports.io/football/leagues/71.png",
            pais: ligas[0].p, bandeira_pais: ligas[0].f,
            home: { name: t1.n, logo: t1.l }, away: { name: t2.n, logo: t2.l },
            data: dataJogo.toISOString(), status: "NS", ativo: true,
            odds: { casa: "1.90", empate: "3.20", fora: "2.50" },
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
