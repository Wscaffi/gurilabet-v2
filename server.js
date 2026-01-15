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
        
        const userCheck = await pool.query("SELECT id FROM usuarios WHERE id = 1");
        if(userCheck.rows.length === 0) {
            const hash = await bcrypt.hash('sistema123', 10);
            await pool.query("INSERT INTO usuarios (id, nome, email, senha) VALUES (1, 'Cliente Balcão', 'sistema@gurila.com', $1)", [hash]);
        }
        console.log("✅ Banco Conectado!");
    } catch (e) { console.error("❌ Erro Banco:", e.message); }
}
initDb();

// --- ROTA DE DIAGNÓSTICO (SEM MÁSCARA) ---
app.get('/api/jogos', async (req, res) => {
    const dataFiltro = req.query.data || new Date().toISOString().split('T')[0];
    
    try {
        // Verifica se a chave existe mesmo
        if (!process.env.API_FOOTBALL_KEY) {
            throw new Error("A variável API_FOOTBALL_KEY não foi encontrada no Railway.");
        }

        const headers = { 
            'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
            'x-rapidapi-host': 'v3.football.api-sports.io'
        };
        
        const isAoVivo = req.query.aovivo === 'true';
        let url = isAoVivo 
            ? `https://v3.football.api-sports.io/fixtures?live=all`
            : `https://v3.football.api-sports.io/fixtures?date=${dataFiltro}`;

        console.log(`Tentando conectar na API: ${url}`); // Log para debug

        // Aumentei o tempo limite para 15 segundos para garantir
        const resp = await axios.get(url, { headers, timeout: 15000 });
        
        // Se a API retornar erro de permissão/conta
        if (resp.data.errors && Object.keys(resp.data.errors).length > 0) {
            return res.status(500).json({ 
                erro_tipo: "API_REJEITOU",
                detalhes: resp.data.errors,
                dica: "Sua conta na API pode estar bloqueada, sem limite ou a chave está errada."
            });
        }

        let fixtures = resp.data.response;
        
        // Se a lista vier vazia da API
        if (!fixtures || fixtures.length === 0) {
             return res.status(200).json({ 
                 erro_tipo: "LISTA_VAZIA",
                 mensagem: "A API funcionou, mas não retornou nenhum jogo para hoje.",
                 data_buscada: dataFiltro,
                 dica: "Pode ser que os jogos de hoje já tenham acabado ou o fuso horário esteja diferente."
             });
        }

        // Se chegou aqui, deu certo! Formata e manda.
        res.json(formatar(fixtures));

    } catch (e) {
        // AQUI ESTÁ O DIAGNÓSTICO: Mostra o erro real na tela
        res.status(500).json({
            erro_critico: "Ocorreu um erro na conexão",
            mensagem_erro: e.message,
            codigo_erro: e.code || "Sem código",
            chave_configurada: process.env.API_FOOTBALL_KEY ? "SIM (Oculta)" : "NÃO",
            host_usado: 'v3.football.api-sports.io'
        });
    }
});

function formatar(data) {
    return data.map(j => {
        const status = j.fixture.status.short;
        // Removi o filtro de 'FT' (Finished) temporariamente para vermos se aparece algo
        // if (['FT', 'AET', 'PEN'].includes(status)) return null; 

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
            mercados: {
                dupla_chance: { casa_empate: "1.25", casa_fora: "1.30", empate_fora: "1.60" },
                total_gols: { mais_15: "1.30", menos_15: "3.20", mais_25: "1.90", menos_25: "1.80" },
                ambas_marcam: { sim: "1.75", nao: "1.95" },
                intervalo_final: { "Casa/Casa": "2.50", "Empate/Empate": "4.50", "Fora/Fora": "5.00" }
            }
        };
    }).filter(Boolean);
}

// Mantenha as outras rotas (login, cadastro, finalizar) iguais...
app.post('/api/cadastro', async (req, res) => {
    try {
        const { nome, email, senha } = req.body;
        if(!email || !senha || senha.length < 6) return res.status(400).json({ erro: "Dados inválidos." });
        const hash = await bcrypt.hash(senha, 10);
        const result = await pool.query('INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo', [nome, email, hash]);
        res.json({ sucesso: true, usuario: result.rows[0] });
    } catch (e) { if(e.code === '23505') return res.status(400).json({ erro: "E-mail já cadastrado." }); res.status(500).json({ erro: "Erro no servidor." }); }
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
