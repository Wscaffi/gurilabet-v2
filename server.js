const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs'); // SEGURANÇA PROFISSIONAL

const app = express();
app.use(express.json());

// CONFIGURAÇÃO DE CORS (Segurança)
// Em produção, troque o '*' pela URL do seu front na Vercel
app.use(cors({ origin: '*' }));

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- INICIALIZAÇÃO ROBUSTA DO BANCO ---
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

        // Garante que existe o usuário padrão para apostas de balcão (ID 1)
        const userCheck = await pool.query("SELECT id FROM usuarios WHERE id = 1");
        if(userCheck.rows.length === 0) {
            // Senha hashada para segurança, mesmo sendo usuário interno
            const hash = await bcrypt.hash('sistema123', 10);
            await pool.query("INSERT INTO usuarios (id, nome, email, senha) VALUES (1, 'Cliente Balcão', 'sistema@gurila.com', $1)", [hash]);
            console.log("✅ Usuário Balcão criado.");
        }

        console.log("✅ Banco Gurila Bet Conectado e Otimizado!");
    } catch (e) { console.error("❌ Erro Crítico Banco:", e.message); }
}
initDb();

// --- ROTA DE JOGOS (COM TRATAMENTO DE ERRO MELHORADO) ---
app.get('/api/jogos', async (req, res) => {
    try {
        const headers = { 
            'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
            'x-rapidapi-host': 'v3.football.api-sports.io'
        };
        
        const isAoVivo = req.query.aovivo === 'true';
        let url = isAoVivo 
            ? `https://v3.football.api-sports.io/fixtures?live=all`
            : `https://v3.football.api-sports.io/fixtures?date=${req.query.data || new Date().toISOString().split('T')[0]}`;

        const resp = await axios.get(url, { headers, timeout: 8000 }); // Timeout menor para não travar
        
        if (resp.data.errors && Object.keys(resp.data.errors).length > 0) throw new Error("API Limit");
        
        let fixtures = resp.data.response;
        if (!fixtures || fixtures.length === 0) {
             if(!isAoVivo) throw new Error("Empty List");
             else fixtures = [];
        }

        res.json(formatar(fixtures));

    } catch (e) {
        console.log(`⚠️ API Error (${e.message}). Usando Backup.`);
        res.json(gerarJogosFalsos(req.query.data || new Date().toISOString().split('T')[0]));
    }
});

function formatar(data) {
    const agora = new Date();
    return data.map(j => {
        // Lógica de tempo mais segura
        const dataJogo = new Date(j.fixture.date);
        const status = j.fixture.status.short;
        // Filtra jogos que já acabaram (FT, AET, PEN)
        if (['FT', 'AET', 'PEN'].includes(status)) return null;

        return {
            id: j.fixture.id,
            liga: j.league.name,
            logo_liga: j.league.logo,
            home: { name: j.teams.home.name, logo: j.teams.home.logo },
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date,
            status: status,
            // IMPORTANTE: Em um app real, aqui você pegaria as odds da API
            // endpoint: /odds?fixture=ID
            // Por enquanto, mantive sua lógica, mas saiba que para profissionalizar, precisamos mudar isso.
            odds: { 
                casa: (1.5 + (j.fixture.id % 10)/20).toFixed(2), // Truque: Odd fixa baseada no ID (não muda no refresh)
                empate: (3.0 + (j.fixture.id % 5)/10).toFixed(2), 
                fora: (2.2 + (j.fixture.id % 8)/10).toFixed(2) 
            }
        };
    }).filter(Boolean); // Remove nulls de forma limpa
}

// --- ROTA DE CADASTRO PROFISSIONAL ---
app.post('/api/cadastro', async (req, res) => {
    try {
        const { nome, email, senha } = req.body;
        // Validação básica
        if(!email || !senha || senha.length < 6) return res.status(400).json({ erro: "Dados inválidos." });

        const hash = await bcrypt.hash(senha, 10); // Criptografia segura
        
        const result = await pool.query(
            'INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo',
            [nome, email, hash]
        );
        res.json({ sucesso: true, usuario: result.rows[0] });
    } catch (e) { 
        // Evita expor erro SQL exato para o cliente
        if(e.code === '23505') return res.status(400).json({ erro: "E-mail já está em uso." });
        res.status(500).json({ erro: "Erro interno no servidor." }); 
    }
});

// --- ROTA DE LOGIN (Faltava no seu código original) ---
app.post('/api/login', async (req, res) => {
    try {
        const { email, senha } = req.body;
        const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
        
        if (result.rows.length === 0) return res.status(400).json({ erro: "Usuário ou senha incorretos." });
        
        const user = result.rows[0];
        const senhaBate = await bcrypt.compare(senha, user.senha); // Comparação segura
        
        if (!senhaBate) return res.status(400).json({ erro: "Usuário ou senha incorretos." });

        delete user.senha; // Nunca retorne a senha, mesmo hashada
        res.json({ sucesso: true, usuario: user });
    } catch (e) { res.status(500).json({ erro: "Erro no login." }); }
});

// --- FINALIZAR APOSTA ---
app.post('/api/finalizar', async (req, res) => {
    const { usuario_id, valor, apostas, odd_total } = req.body;
    
    // Validações de segurança no Back-end
    if (!apostas || apostas.length === 0) return res.status(400).json({ erro: "Nenhuma aposta selecionada." });
    if (valor <= 0) return res.status(400).json({ erro: "Valor inválido." });

    const codigo = "GB" + Math.floor(100000 + Math.random() * 900000); // Gera código GB123456
    
    // Trava de segurança de pagamento máximo
    let retornoCalc = (valor * odd_total);
    const TETO_MAXIMO = 2500.00;
    if(retornoCalc > TETO_MAXIMO) retornoCalc = TETO_MAXIMO;
    
    const idUser = usuario_id || 1; // Usa ID 1 se não vier usuário

    try {
        await pool.query(
            'INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)',
            [idUser, codigo, valor, retornoCalc.toFixed(2), odd_total, JSON.stringify(apostas)]
        );
        res.json({ sucesso: true, codigo, retorno: retornoCalc.toFixed(2) });
    } catch (e) { 
        console.error(e);
        res.status(500).json({ erro: "Erro ao processar bilhete." });
    }
});

// Mantenha as funções auxiliares (gerarJogosFalsos) aqui embaixo...
// (Copie sua função gerarJogosFalsos original para cá, ela estava ok para testes)

function gerarJogosFalsos(data) {
    // ... (mesma lógica sua, só para economizar espaço aqui)
    // Dica: Use a mesma lógica de "Odds baseada no ID" que fiz no formatar()
    // para que os jogos falsos também não fiquem mudando de odd toda hora.
    return []; // Coloque o código da sua função aqui
}

app.listen(process.env.PORT || 3000, () => {
    console.log(`🔥 Servidor rodando na porta ${process.env.PORT || 3000}`);
});
