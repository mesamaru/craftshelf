-- 配布元に紐づいているのにアイコンの空のもの(過去に紐づけた分)を、取り直しの順番待ちに戻す(1 分ごとに 50 件まで。そこでアイコンを補う)
UPDATE "library_item" SET "info_at" = NULL WHERE "source" <> 'upload' AND "icon_url" = '';
