from knowledge_graph_service import KnowledgeGraphService


class MemoryService:
    def __init__(self, knowledge_graph_service: KnowledgeGraphService):
        self.knowledge_graph_service = knowledge_graph_service

    def store_memory(self, text: str) -> None:
        self.knowledge_graph_service.extract_and_store_graph(text)

    def archive_memory(self, text: str) -> None:
        self.knowledge_graph_service.extract_and_store_graph(text)

    def restore_memory(self, text: str) -> None:
        self.knowledge_graph_service.extract_and_store_graph(text)


class ExplicitFieldMemoryService:
    def __init__(self, knowledge_graph_service):
        self.knowledge_graph_service: KnowledgeGraphService = knowledge_graph_service

    def ingest_memory(self, text: str) -> None:
        self.knowledge_graph_service.extract_and_store_graph(text)
