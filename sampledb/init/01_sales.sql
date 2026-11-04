-- Demo dataset for Vita: a small "sales" schema.
-- Runs automatically the first time the sampledb volume is created.
-- Deterministic: setseed() makes random() return the same sequence every time.

SELECT setseed(0.42);

CREATE SCHEMA sales;

CREATE TABLE sales.customers (
    id          serial PRIMARY KEY,
    name        text NOT NULL,
    email       text NOT NULL UNIQUE,
    country     text NOT NULL,
    city        text NOT NULL,
    signup_date date NOT NULL
);

CREATE TABLE sales.products (
    id         serial PRIMARY KEY,
    name       text NOT NULL,
    category   text NOT NULL,
    unit_price numeric(10, 2) NOT NULL
);

CREATE TABLE sales.orders (
    id          serial PRIMARY KEY,
    customer_id integer NOT NULL REFERENCES sales.customers (id),
    order_date  date NOT NULL,
    status      text NOT NULL,
    channel     text NOT NULL
);

CREATE TABLE sales.order_items (
    id         serial PRIMARY KEY,
    order_id   integer NOT NULL REFERENCES sales.orders (id),
    product_id integer NOT NULL REFERENCES sales.products (id),
    quantity   integer NOT NULL,
    unit_price numeric(10, 2) NOT NULL
);

-- 30 products in 5 categories
INSERT INTO sales.products (name, category, unit_price) VALUES
    ('Wireless Mouse', 'Electronics', 24.99),
    ('Mechanical Keyboard', 'Electronics', 89.00),
    ('USB-C Hub', 'Electronics', 39.50),
    ('27" Monitor', 'Electronics', 249.00),
    ('Noise-Cancelling Headphones', 'Electronics', 199.00),
    ('Webcam HD', 'Electronics', 59.90),
    ('Desk Lamp', 'Home', 34.00),
    ('Ergonomic Chair', 'Home', 329.00),
    ('Standing Desk', 'Home', 499.00),
    ('Plant Pot', 'Home', 15.50),
    ('Wall Clock', 'Home', 27.00),
    ('Throw Blanket', 'Home', 45.00),
    ('Notebook A5', 'Office', 6.50),
    ('Gel Pens (10-pack)', 'Office', 9.99),
    ('Desk Organizer', 'Office', 22.00),
    ('Whiteboard', 'Office', 79.00),
    ('Paper Shredder', 'Office', 119.00),
    ('Stapler', 'Office', 12.00),
    ('Running Shoes', 'Sports', 110.00),
    ('Yoga Mat', 'Sports', 29.00),
    ('Water Bottle', 'Sports', 18.00),
    ('Dumbbell Set', 'Sports', 140.00),
    ('Fitness Tracker', 'Sports', 129.00),
    ('Tennis Racket', 'Sports', 95.00),
    ('Coffee Beans 1kg', 'Grocery', 24.00),
    ('Green Tea (50 bags)', 'Grocery', 8.50),
    ('Dark Chocolate Box', 'Grocery', 14.00),
    ('Olive Oil 1L', 'Grocery', 16.90),
    ('Granola 500g', 'Grocery', 7.20),
    ('Honey Jar', 'Grocery', 11.00);

-- 150 customers
WITH
base AS (
    SELECT
        g,
        (ARRAY['Emma','Liam','Olivia','Noah','Sofia','Lucas','Mia','Omar','Yara','Adam',
               'Lea','Hugo','Nora','Ines','Sami','Lina','Karim','Julia','Max','Amira'])
            [1 + floor(random() * 20)::int] AS first_name,
        (ARRAY['Smith','Martin','Garcia','Muller','Rossi','Dubois','Haddad','Jansen','Silva','Nowak',
               'Bennani','Lopez','Schmidt','Moreau','Kowalski','Brown','Peeters','Costa','Fischer','Alaoui'])
            [1 + floor(random() * 20)::int] AS last_name,
        1 + floor(random() * 12)::int AS loc_idx,
        date '2023-01-01' + floor(random() * 1400)::int AS signup_date
    FROM generate_series(1, 150) AS g
),
locations (idx, country, city) AS (
    VALUES
        (1, 'United States', 'New York'), (2, 'United States', 'Chicago'),
        (3, 'United Kingdom', 'London'), (4, 'Germany', 'Berlin'),
        (5, 'France', 'Paris'), (6, 'Netherlands', 'Amsterdam'),
        (7, 'Belgium', 'Brussels'), (8, 'Spain', 'Madrid'),
        (9, 'Morocco', 'Casablanca'), (10, 'Italy', 'Milan'),
        (11, 'Canada', 'Toronto'), (12, 'Netherlands', 'Rotterdam')
)
INSERT INTO sales.customers (name, email, country, city, signup_date)
SELECT
    first_name || ' ' || last_name,
    lower(first_name || '.' || last_name || g) || '@example.com',
    l.country,
    l.city,
    signup_date
FROM base
JOIN locations AS l ON l.idx = base.loc_idx
ORDER BY g;

-- 800 orders between 2024-11-01 and 2026-10-31.
-- sqrt(random()) skews dates toward the end, so sales grow over time.
WITH base AS (
    SELECT
        1 + floor(random() * 150)::int AS customer_id,
        date '2024-11-01' + floor(sqrt(random()) * 730)::int AS order_date,
        random() AS status_roll,
        random() AS channel_roll
    FROM generate_series(1, 800)
)
INSERT INTO sales.orders (customer_id, order_date, status, channel)
SELECT
    customer_id,
    order_date,
    CASE
        WHEN status_roll < 0.80 THEN 'completed'
        WHEN status_roll < 0.90 THEN 'shipped'
        WHEN status_roll < 0.96 THEN 'cancelled'
        ELSE 'returned'
    END,
    CASE
        WHEN channel_roll < 0.55 THEN 'web'
        WHEN channel_roll < 0.85 THEN 'mobile'
        ELSE 'store'
    END
FROM base
ORDER BY order_date;

-- 1 to 4 items per order (~2,000 rows). The LATERAL subqueries reference the
-- outer row so Postgres re-evaluates random() for every row.
INSERT INTO sales.order_items (order_id, product_id, quantity, unit_price)
SELECT o.id, p.id, 1 + floor(random() * 3)::int, p.unit_price
FROM sales.orders AS o
CROSS JOIN LATERAL generate_series(1, 1 + floor(random() * 4)::int + 0 * o.id) AS item
CROSS JOIN LATERAL (
    SELECT id, unit_price
    FROM sales.products
    WHERE item > 0
    ORDER BY random()
    LIMIT 1
) AS p;

-- A view with one row per order, handy for charts.
CREATE VIEW sales.order_totals AS
SELECT
    o.id AS order_id,
    o.order_date,
    o.customer_id,
    o.status,
    o.channel,
    SUM(oi.quantity) AS items,
    SUM(oi.quantity * oi.unit_price) AS total
FROM sales.orders AS o
JOIN sales.order_items AS oi ON oi.order_id = o.id
GROUP BY o.id;

ANALYZE;
