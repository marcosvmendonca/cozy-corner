
CREATE POLICY "wa_media_read_auth" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'whatsapp-media');
CREATE POLICY "wa_media_write_auth" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'whatsapp-media');
CREATE POLICY "wa_media_update_auth" ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'whatsapp-media');
CREATE POLICY "wa_media_delete_admin" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'whatsapp-media' AND public.has_role(auth.uid(), 'admin'));

-- Também permitir uploads pelo webhook via service_role (já tem ALL por default no storage, sem alteração necessária)
