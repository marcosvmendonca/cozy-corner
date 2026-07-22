
-- QUEUES
CREATE TABLE public.queues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#2f6b4a',
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.queues TO authenticated;
GRANT ALL ON public.queues TO service_role;
ALTER TABLE public.queues ENABLE ROW LEVEL SECURITY;

-- QUEUE MEMBERS
CREATE TABLE public.queue_members (
  queue_id UUID NOT NULL REFERENCES public.queues(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (queue_id, user_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.queue_members TO authenticated;
GRANT ALL ON public.queue_members TO service_role;
ALTER TABLE public.queue_members ENABLE ROW LEVEL SECURITY;

-- Helper
CREATE OR REPLACE FUNCTION public.is_queue_member(_queue_id UUID, _user_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS(SELECT 1 FROM public.queue_members WHERE queue_id = _queue_id AND user_id = _user_id)
$$;

-- Policies for queues
CREATE POLICY queues_select ON public.queues FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR public.is_queue_member(id, auth.uid()));
CREATE POLICY queues_admin_all ON public.queues FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- Policies for queue_members
CREATE POLICY qm_select ON public.queue_members FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR user_id = auth.uid());
CREATE POLICY qm_admin_all ON public.queue_members FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- Update trigger
CREATE TRIGGER update_queues_updated_at BEFORE UPDATE ON public.queues
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- CONVERSATIONS: add queue_id + accepted_at
ALTER TABLE public.conversations
  ADD COLUMN queue_id UUID REFERENCES public.queues(id) ON DELETE SET NULL,
  ADD COLUMN accepted_at TIMESTAMPTZ;

CREATE INDEX idx_conversations_queue_id ON public.conversations(queue_id);
CREATE INDEX idx_conversations_assigned ON public.conversations(assigned_agent_id);
CREATE INDEX idx_conversations_status ON public.conversations(status);

-- Rewrite conversations policies (tighten from 'true')
DROP POLICY IF EXISTS conversations_read_all_authenticated ON public.conversations;
DROP POLICY IF EXISTS conversations_update_authenticated ON public.conversations;

CREATE POLICY conversations_select ON public.conversations FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(),'admin')
    OR assigned_agent_id = auth.uid()
    OR (status = 'waiting' AND assigned_agent_id IS NULL)
    OR (queue_id IS NOT NULL AND public.is_queue_member(queue_id, auth.uid()))
  );

CREATE POLICY conversations_update ON public.conversations FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(),'admin')
    OR assigned_agent_id = auth.uid()
    OR (status = 'waiting' AND assigned_agent_id IS NULL)
    OR (queue_id IS NOT NULL AND public.is_queue_member(queue_id, auth.uid()))
  )
  WITH CHECK (
    public.has_role(auth.uid(),'admin')
    OR assigned_agent_id = auth.uid()
    OR (queue_id IS NOT NULL AND public.is_queue_member(queue_id, auth.uid()))
  );

-- MESSAGES: replace ALL with SELECT/INSERT tied to conversation visibility
DROP POLICY IF EXISTS messages_all_authenticated ON public.messages;

CREATE POLICY messages_select ON public.messages FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.conversations c WHERE c.id = conversation_id AND (
      public.has_role(auth.uid(),'admin')
      OR c.assigned_agent_id = auth.uid()
      OR (c.status = 'waiting' AND c.assigned_agent_id IS NULL)
      OR (c.queue_id IS NOT NULL AND public.is_queue_member(c.queue_id, auth.uid()))
    )
  ));

CREATE POLICY messages_insert ON public.messages FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.conversations c WHERE c.id = conversation_id AND (
      public.has_role(auth.uid(),'admin')
      OR c.assigned_agent_id = auth.uid()
      OR (c.queue_id IS NOT NULL AND public.is_queue_member(c.queue_id, auth.uid()))
    )
  ));
