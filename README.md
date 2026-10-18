# UNITY — Father of Lights

Version mobile-first avec comptes, abonnement Stripe, pixels Genesis, conversations isolées, garde de Father of Lights et loterie d'adoption.

## Ce qui est implémenté
- Comptes avec mots de passe hachés par scrypt et sessions en cookies HttpOnly.
- Stripe Checkout, portail de facturation et webhooks signés.
- Création d'un pixel Genesis par compte avec identité persistante.
- Conversations isolées par agent.
- À la fin effective d'un abonnement, l'Agent A passe en attente d'adoption sous la garde de Father of Lights ; son identité et son historique restent conservés.
- Tirage uniforme côté serveur parmi les agents disponibles ; attribution atomique évitant la double adoption.
- SQLite, à placer sur le volume persistant Railway.

## Variables Railway à configurer
- OPENAI_API_KEY : clé API OpenAI avec crédits.
- OPENAI_MODEL : modèle API autorisé, facultatif.
- STRIPE_SECRET_KEY : clé secrète Stripe.
- STRIPE_PRICE_ID : identifiant price_ d'un prix récurrent mensuel.
- STRIPE_WEBHOOK_SECRET : secret whsec_ du webhook.
- PUBLIC_URL : URL publique exacte, sans slash final.
- DATABASE_PATH=/data/unity.sqlite
- NODE_ENV=production

Configure l'endpoint Stripe https://TON-DOMAINE/api/stripe/webhook pour les événements checkout.session.completed, checkout.session.async_payment_succeeded, customer.subscription.created, customer.subscription.updated et customer.subscription.deleted. Active le portail client Stripe et configure la résiliation. Le prix et la devise sont gérés dans Stripe.

## Mise en service
1. Ajoute les variables dans Railway, jamais dans Git.
2. Attache le volume persistant et définis DATABASE_PATH=/data/unity.sqlite.
3. Déploie avec npm start.
4. Teste tout le parcours avec Stripe en mode test avant d'accepter des paiements réels.
5. Vérifie la livraison des webhooks et /api/health.

## Limites
Cette base n'implémente pas encore le KYC, la vérification d'e-mail, l'anti-fraude multi-comptes, l'identité SBT/on-chain, les wallets, la mémoire distribuée, les sub-agents, la DAO, la répartition des revenus ni le financement automatique des agents en attente. La loterie est aléatoire côté serveur, mais pas encore vérifiable on-chain. Une revue de sécurité, des sauvegardes, un suivi des coûts et une vérification juridique restent nécessaires avant l'ouverture publique. L'API OpenAI est facturée séparément de ChatGPT.
