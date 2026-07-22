
-- =========================================================
-- CRM WhatsApp — Schema inicial
-- =========================================================

-- Roles enum
CREATE TYPE public.app_role AS ENUM ('admin', 'agent');

-- Profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  avatar_url TEXT,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- User roles (segurança: separado do profile)
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- has_role helper
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

-- Auto-criar profile + role de admin p/ 1o usuário; agent p/ demais
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  user_count INT;
BEGIN
  INSERT INTO public.profiles (id, full_name, email, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    NEW.email,
    NEW.raw_user_meta_data->>'avatar_url'
  );

  SELECT COUNT(*) INTO user_count FROM public.profiles;
  IF user_count = 1 THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin');
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'agent');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Profiles policies
CREATE POLICY "profiles_select_all_authenticated" ON public.profiles
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id);
CREATE POLICY "profiles_admin_all" ON public.profiles
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- user_roles policies
CREATE POLICY "user_roles_select_self_or_admin" ON public.user_roles
  FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "user_roles_admin_manage" ON public.user_roles
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- =========================================================
-- Tags
-- =========================================================
CREATE TABLE public.tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#6366f1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tags TO authenticated;
GRANT ALL ON public.tags TO service_role;
ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tags_read_authenticated" ON public.tags FOR SELECT TO authenticated USING (true);
CREATE POLICY "tags_admin_manage" ON public.tags FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- =========================================================
-- Contacts
-- =========================================================
CREATE TABLE public.contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL UNIQUE, -- E.164
  name TEXT,
  avatar_url TEXT,
  email TEXT,
  notes TEXT,
  extracted_data JSONB NOT NULL DEFAULT '{}'::JSONB, -- dados extraídos pela IA
  tags UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contacts TO authenticated;
GRANT ALL ON public.contacts TO service_role;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "contacts_all_authenticated" ON public.contacts FOR ALL TO authenticated USING (true);
CREATE INDEX contacts_phone_idx ON public.contacts(phone);

-- =========================================================
-- Conversations
-- =========================================================
CREATE TYPE public.conversation_status AS ENUM ('waiting', 'open', 'resolved');

CREATE TABLE public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  status public.conversation_status NOT NULL DEFAULT 'waiting',
  assigned_agent_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ai_enabled BOOLEAN NOT NULL DEFAULT true,
  ai_summary TEXT,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_preview TEXT,
  unread_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations TO authenticated;
GRANT ALL ON public.conversations TO service_role;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "conversations_read_all_authenticated" ON public.conversations FOR SELECT TO authenticated USING (true);
CREATE POLICY "conversations_update_authenticated" ON public.conversations FOR UPDATE TO authenticated USING (true);
CREATE POLICY "conversations_insert_authenticated" ON public.conversations FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "conversations_delete_admin" ON public.conversations FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE INDEX conversations_status_idx ON public.conversations(status);
CREATE INDEX conversations_last_msg_idx ON public.conversations(last_message_at DESC);

-- =========================================================
-- Messages
-- =========================================================
CREATE TYPE public.message_direction AS ENUM ('in', 'out');
CREATE TYPE public.message_type AS ENUM ('text', 'image', 'audio', 'video', 'document', 'system');
CREATE TYPE public.message_sender AS ENUM ('customer', 'agent', 'ai', 'flow', 'system');

CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  direction public.message_direction NOT NULL,
  type public.message_type NOT NULL DEFAULT 'text',
  body TEXT,
  media_url TEXT,
  media_path TEXT, -- caminho no storage
  media_mime TEXT,
  media_duration_ms INT,
  sent_by public.message_sender NOT NULL,
  sender_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  external_id TEXT, -- id da mensagem na Evolution API
  status TEXT NOT NULL DEFAULT 'sent', -- sent | delivered | read | failed | pending
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO authenticated;
GRANT ALL ON public.messages TO service_role;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "messages_all_authenticated" ON public.messages FOR ALL TO authenticated USING (true);
CREATE INDEX messages_conv_idx ON public.messages(conversation_id, created_at);

-- =========================================================
-- Quick replies
-- =========================================================
CREATE TABLE public.quick_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE, -- NULL = compartilhado com equipe
  shortcut TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quick_replies TO authenticated;
GRANT ALL ON public.quick_replies TO service_role;
ALTER TABLE public.quick_replies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "quick_replies_read_own_or_shared" ON public.quick_replies
  FOR SELECT TO authenticated USING (owner_id IS NULL OR owner_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "quick_replies_manage_own" ON public.quick_replies
  FOR ALL TO authenticated USING (owner_id = auth.uid() OR (owner_id IS NULL AND public.has_role(auth.uid(), 'admin')));

-- =========================================================
-- Flows (construtor de fluxo)
-- =========================================================
CREATE TABLE public.flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT false,
  graph JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::JSONB,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.flows TO authenticated;
GRANT ALL ON public.flows TO service_role;
ALTER TABLE public.flows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "flows_read_all" ON public.flows FOR SELECT TO authenticated USING (true);
CREATE POLICY "flows_admin_manage" ON public.flows FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE UNIQUE INDEX flows_only_one_active ON public.flows (is_active) WHERE is_active = true;

-- Estado das execuções de fluxo por conversa
CREATE TABLE public.flow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL UNIQUE REFERENCES public.conversations(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  current_node_id TEXT,
  context JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'active', -- active | done | error
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.flow_runs TO authenticated;
GRANT ALL ON public.flow_runs TO service_role;
ALTER TABLE public.flow_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "flow_runs_all_authenticated" ON public.flow_runs FOR ALL TO authenticated USING (true);

-- =========================================================
-- Settings (key-value)
-- =========================================================
CREATE TABLE public.settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.settings TO authenticated;
GRANT ALL ON public.settings TO service_role;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "settings_read_authenticated" ON public.settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "settings_admin_manage" ON public.settings FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- Seeds de settings
INSERT INTO public.settings (key, value) VALUES
  ('ai', jsonb_build_object(
     'system_prompt', 'Você é um atendente cordial e objetivo. Responda em português brasileiro, seja breve, use tom amigável e profissional. Confirme entendimento antes de agir. Quando o cliente pedir para falar com um humano ou o problema for delicado, avise que vai transferir para um atendente humano.',
     'auto_reply', true,
     'suggest_replies', true,
     'auto_reply_max_messages', 6,
     'handoff_keywords', ARRAY['humano','atendente','pessoa','falar com alguém']
  )),
  ('whatsapp', jsonb_build_object(
     'provider', 'evolution',
     'instance_name', '',
     'connected', false,
     'phone', ''
  ));

-- =========================================================
-- update_updated_at trigger reusable
-- =========================================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_contacts_updated BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_conversations_updated BEFORE UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_flows_updated BEFORE UPDATE ON public.flows FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_flow_runs_updated BEFORE UPDATE ON public.flow_runs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =========================================================
-- Realtime
-- =========================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.settings;
ALTER TABLE public.messages REPLICA IDENTITY FULL;
ALTER TABLE public.conversations REPLICA IDENTITY FULL;
